import { randomUUID } from "node:crypto";
import { createCacheKey, type CacheClient } from "@knoviq/cache";
import { createDomainEvent, type EventPublisher } from "@knoviq/events";
import { createTimer } from "@knoviq/observability";

import { chunkDocument, sha256Hex } from "./chunker.js";
import type { KnowledgeSettings } from "./config.js";
import type { EmbeddingProvider } from "./embedding.js";
import { badRequest } from "./errors.js";
import type { KnowledgeRepository, InsertChunkInput } from "./repository.js";
import { createReranker, type Reranker } from "./reranker.js";
import type { SearchRequest } from "./schemas.js";
import { extractDocumentText } from "./text-extractor.js";
import type {
  DocumentChunk,
  SearchResult,
  UploadedDocumentResponse,
  UploadDocumentInput,
} from "./types.js";
import { saveUploadedFile } from "./storage.js";

export class KnowledgeService {
  private readonly reranker: Reranker;

  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly settings: KnowledgeSettings,
    private readonly cache: CacheClient,
    private readonly eventPublisher: EventPublisher,
  ) {
    this.reranker = createReranker(settings);
  }

  async uploadDocument(
    input: UploadDocumentInput,
    requestId: string,
  ): Promise<UploadedDocumentResponse> {
    await this.repository.ensureMembership(input.tenantId, input.ownerId);

    const checksum = sha256Hex(input.buffer);
    await this.repository.ensureNoDuplicateDocument(input.tenantId, checksum);

    const documentId = randomUUID();
    const storageKey = await saveUploadedFile({
      buffer: input.buffer,
      checksum,
      documentId,
      filename: input.filename,
      tenantId: input.tenantId,
      uploadDir: this.settings.uploadDir,
    });
    const extracted = await extractDocumentText(input.buffer, input.mimeType);
    const chunks = chunkDocument({
      chunkOverlapChars: this.settings.chunkOverlapChars,
      chunkTargetChars: this.settings.chunkTargetChars,
      extracted,
    });

    if (chunks.length === 0) {
      throw badRequest("Document did not produce any chunks");
    }

    await this.repository.createDocument({
      checksum,
      documentId,
      fileSizeBytes: input.sizeBytes,
      filename: input.filename,
      metadata: {
        ...input.metadata,
        pageCount: extracted.pageCount ?? null,
        textLength: extracted.text.length,
      },
      mimeType: input.mimeType,
      ownerId: input.ownerId,
      storageKey,
      tenantId: input.tenantId,
      title: input.title,
      visibility: input.visibility,
    });

    try {
      const embeddedChunks = await this.embedChunks(
        chunks,
        input.tenantId,
        input.ownerId,
        requestId,
      );
      await this.repository.insertChunks(
        embeddedChunks.map((chunk) => ({
          ...chunk,
          documentId,
          tenantId: input.tenantId,
        })),
      );
      await this.repository.markDocumentReady({
        chunkCount: chunks.length,
        documentId,
        tenantId: input.tenantId,
        tokenCount: chunks.reduce((sum, chunk) => sum + chunk.estimatedTokens, 0),
      });
      await this.cache.deleteByPattern(searchCachePattern(input.tenantId, input.ownerId));
      await this.eventPublisher.publish({
        event: createDomainEvent({
          data: {
            chunkCount: chunks.length,
            documentId,
            filename: input.filename,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            title: input.title,
            visibility: input.visibility,
          },
          eventType: "knowledge.document.uploaded",
          requestId,
          serviceName: "knowledge-service",
          tenantId: input.tenantId,
          userId: input.ownerId,
        }),
        key: documentId,
        topic: "documents",
      });
    } catch (error) {
      await this.repository.markDocumentFailed({
        documentId,
        failureReason: error instanceof Error ? error.message : "Unknown processing error",
        tenantId: input.tenantId,
      });
      throw error;
    }

    return {
      chunkCount: chunks.length,
      documentId,
      filename: input.filename,
      status: "ready",
      title: input.title,
      visibility: input.visibility,
    };
  }

  async listDocuments(tenantId: string, userId: string) {
    await this.repository.ensureMembership(tenantId, userId);
    return this.repository.listDocuments(tenantId, userId);
  }

  async deleteDocument(
    documentId: string,
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<void> {
    await this.repository.ensureMembership(tenantId, userId);
    await this.repository.deleteDocument({
      documentId,
      tenantId,
      userId,
    });
    await this.cache.deleteByPattern(searchCachePattern(tenantId, userId));
    await this.eventPublisher.publish({
      event: createDomainEvent({
        data: {
          documentId,
        },
        eventType: "knowledge.document.deleted",
        requestId,
        serviceName: "knowledge-service",
        tenantId,
        userId,
      }),
      key: documentId,
      topic: "documents",
    });
  }

  async search(
    input: SearchRequest,
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<SearchResult[]> {
    await this.repository.ensureMembership(tenantId, userId);
    const finalLimit = input.limit ?? this.settings.searchLimit;
    const cacheKey = searchCacheKey(input, tenantId, userId, this.settings);
    const cachedResults = await this.cache.getJson<SearchResult[]>(cacheKey);

    if (cachedResults) {
      return cachedResults;
    }

    if (input.documentIds) {
      for (const documentId of input.documentIds) {
        await this.repository.getDocumentForTenant(tenantId, documentId);
      }
    }

    const timer = createTimer();
    const embedding = await this.embeddings.embedTexts([input.query], userId);

    await this.repository.recordEmbeddingUsage({
      cached: false,
      latencyMs: timer.stop(),
      modelDeployment: embedding.model,
      promptTokens: embedding.promptTokens,
      provider: embedding.provider,
      requestId,
      tenantId,
      userId,
    });

    // ── Stage 1: Hybrid retrieval (vector + BM25 + RRF) ──────────────────────
    // We over-fetch by rerankCandidates so the reranker has a wide candidate pool.
    const candidates = await this.repository.searchChunks({
      documentIds: input.documentIds,
      limit: this.settings.rerankCandidates,
      minSimilarity: input.minSimilarity ?? this.settings.searchMinSimilarity,
      queryEmbedding: embedding.vectors[0] ?? [],
      queryText: input.query,
      tenantId,
      userId,
    });

    // ── Stage 2: LLM reranking ────────────────────────────────────────────────
    // Re-scores each candidate against the query using AZURE_OPENAI_CHAT_DEPLOYMENT_FAST.
    // Falls back gracefully to RRF order if the LLM call fails.
    const results = await this.reranker.rerank(input.query, candidates, finalLimit);

    await this.cache.setJson(cacheKey, results, this.settings.searchCacheTtlSeconds);
    return results;
  }

  private async embedChunks(
    chunks: DocumentChunk[],
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<InsertChunkInput[]> {
    const cachedEmbeddings = await this.repository.findCachedEmbeddings({
      contentHashes: chunks.map((chunk) => chunk.contentHash),
      embeddingModel: this.embeddings.model,
      tenantId,
    });
    const missingChunks = chunks.filter((chunk) => !cachedEmbeddings.has(chunk.contentHash));
    const newVectors = new Map<string, number[]>();

    if (missingChunks.length > 0) {
      const timer = createTimer();
      const embedding = await this.embeddings.embedTexts(
        missingChunks.map((chunk) => chunk.content),
        userId,
      );
      const latencyMs = timer.stop();

      missingChunks.forEach((chunk, index) => {
        const vector = embedding.vectors[index];

        if (!vector) {
          throw new Error("Embedding response did not include all requested chunks");
        }

        newVectors.set(chunk.contentHash, vector);
      });

      await this.repository.upsertEmbeddingCache({
        embeddingModel: embedding.model,
        embeddings: missingChunks.map((chunk) => ({
          contentHash: chunk.contentHash,
          estimatedTokens: chunk.estimatedTokens,
          vector: newVectors.get(chunk.contentHash) ?? [],
        })),
        tenantId,
      });

      await this.repository.recordEmbeddingUsage({
        cached: false,
        latencyMs,
        modelDeployment: embedding.model,
        promptTokens: embedding.promptTokens,
        provider: embedding.provider,
        requestId,
        tenantId,
        userId,
      });
    }

    if (cachedEmbeddings.size > 0) {
      await this.repository.recordEmbeddingUsage({
        cached: true,
        latencyMs: 0,
        modelDeployment: this.embeddings.model,
        promptTokens: 0,
        provider: this.embeddings.provider,
        requestId,
        tenantId,
        userId,
      });
    }

    return chunks.map((chunk) => {
      const embedding =
        cachedEmbeddings.get(chunk.contentHash) ?? newVectors.get(chunk.contentHash);

      if (!embedding) {
        throw new Error(`Missing embedding for chunk ${chunk.chunkIndex}`);
      }

      return {
        ...chunk,
        embedding,
        embeddingModel: this.embeddings.model,
        tenantId,
        documentId: "",
      };
    });
  }
}

function searchCacheKey(
  input: SearchRequest,
  tenantId: string,
  userId: string,
  settings: KnowledgeSettings,
): string {
  const namespace = `knowledge:search:${tenantId}:${userId}`;

  return createCacheKey(namespace, {
    documentIds: input.documentIds ? [...input.documentIds].sort() : null,
    limit: input.limit ?? settings.searchLimit,
    minSimilarity: input.minSimilarity ?? settings.searchMinSimilarity,
    query: input.query,
  });
}

function searchCachePattern(tenantId: string, userId: string): string {
  return `knowledge:search:${tenantId}:${userId}:*`;
}
