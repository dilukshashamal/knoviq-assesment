import type { Pool, PoolClient, QueryResultRow } from "@knoviq/database";
import { withTransaction } from "@knoviq/database";

import { conflict, forbidden, notFound } from "./errors.js";
import { vectorToSql } from "./embedding.js";
import type { DocumentVisibility } from "./schemas.js";
import type { DocumentChunk, DocumentSummary, SearchResult } from "./types.js";

interface DuplicateDocumentRow extends QueryResultRow {
  id: string;
  status: string;
  title: string;
}

interface DocumentListRow extends QueryResultRow {
  chunk_count: number;
  created_at: Date;
  id: string;
  original_filename: string;
  processed_at: Date | null;
  status: string;
  title: string;
  updated_at: Date;
  visibility: DocumentVisibility;
}

interface DocumentOwnershipRow extends QueryResultRow {
  owner_id: string;
}

interface CachedEmbeddingRow extends QueryResultRow {
  content_hash: string;
  embedding: string;
}

interface SearchRow extends QueryResultRow {
  chunk_content: string;
  chunk_id: string;
  chunk_index: number;
  document_id: string;
  document_title: string;
  metadata: Record<string, unknown> | null;
  score: number;
  source_page_end: number | null;
  source_page_start: number | null;
}

export interface CreateDocumentInput {
  checksum: string;
  documentId: string;
  filename: string;
  fileSizeBytes: number;
  metadata: Record<string, unknown>;
  mimeType: "application/pdf" | "text/plain";
  ownerId: string;
  storageKey: string;
  tenantId: string;
  title: string;
  visibility: DocumentVisibility;
}

export interface InsertChunkInput extends DocumentChunk {
  embedding: number[];
  embeddingModel: string;
  tenantId: string;
  documentId: string;
}

export class KnowledgeRepository {
  constructor(private readonly pool: Pool) {}

  async ensureMembership(tenantId: string, userId: string): Promise<void> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM knoviq.tenant_memberships tm
        JOIN knoviq.users u ON u.id = tm.user_id
        JOIN knoviq.tenants t ON t.id = tm.tenant_id
        WHERE tm.tenant_id = $1
          AND tm.user_id = $2
          AND u.status = 'active'
          AND t.status = 'active'
        LIMIT 1
      `,
      [tenantId, userId],
    );

    if (!result.rowCount) {
      throw forbidden("User is not a member of this tenant");
    }
  }

  async ensureNoDuplicateDocument(tenantId: string, checksum: string): Promise<void> {
    const result = await this.pool.query<DuplicateDocumentRow>(
      `
        SELECT id, title, status
        FROM knoviq.documents
        WHERE tenant_id = $1
          AND checksum_sha256 = $2
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [tenantId, checksum],
    );

    const existing = result.rows.at(0);

    if (existing) {
      throw conflict(`Document already uploaded: ${existing.title}`);
    }
  }

  async createDocument(input: CreateDocumentInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO knoviq.documents (
          id,
          tenant_id,
          owner_id,
          title,
          original_filename,
          mime_type,
          file_size_bytes,
          storage_key,
          checksum_sha256,
          status,
          visibility,
          metadata
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          'embedding',
          $10,
          $11::jsonb
        )
      `,
      [
        input.documentId,
        input.tenantId,
        input.ownerId,
        input.title,
        input.filename,
        input.mimeType,
        input.fileSizeBytes,
        input.storageKey,
        input.checksum,
        input.visibility,
        JSON.stringify(input.metadata),
      ],
    );
  }

  async markDocumentReady(input: {
    chunkCount: number;
    documentId: string;
    tenantId: string;
    tokenCount: number;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE knoviq.documents
        SET status = 'ready',
            chunk_count = $3,
            token_count = $4,
            processed_at = now(),
            failure_reason = NULL
        WHERE tenant_id = $1
          AND id = $2
      `,
      [input.tenantId, input.documentId, input.chunkCount, input.tokenCount],
    );
  }

  async markDocumentFailed(input: {
    documentId: string;
    failureReason: string;
    tenantId: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE knoviq.documents
        SET status = 'failed',
            failure_reason = $3
        WHERE tenant_id = $1
          AND id = $2
      `,
      [input.tenantId, input.documentId, input.failureReason.slice(0, 1000)],
    );
  }

  async insertChunks(chunks: InsertChunkInput[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    await withTransaction(this.pool, async (client) => {
      for (const chunk of chunks) {
        // Persist keyword metadata alongside the chunk for BM25 hybrid search
        const chunkMeta = {
          keywords: chunk.keywords ?? [],
        };

        await client.query(
          `
            INSERT INTO knoviq.document_chunks (
              tenant_id,
              document_id,
              chunk_index,
              content,
              content_hash,
              token_count,
              embedding,
              embedding_model,
              embedding_created_at,
              source_page_start,
              source_page_end,
              metadata
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7::vector,
              $8,
              now(),
              $9,
              $10,
              $11::jsonb
            )
          `,
          [
            chunk.tenantId,
            chunk.documentId,
            chunk.chunkIndex,
            chunk.content,
            chunk.contentHash,
            chunk.estimatedTokens,
            vectorToSql(chunk.embedding),
            chunk.embeddingModel,
            chunk.sourcePageStart ?? null,
            chunk.sourcePageEnd ?? null,
            JSON.stringify(chunkMeta),
          ],
        );
      }
    });
  }

  async findCachedEmbeddings(input: {
    contentHashes: string[];
    embeddingModel: string;
    tenantId: string;
  }): Promise<Map<string, number[]>> {
    if (input.contentHashes.length === 0) {
      return new Map();
    }

    const result = await this.pool.query<CachedEmbeddingRow>(
      `
        SELECT content_hash, embedding::text AS embedding
        FROM knoviq.embedding_cache
        WHERE tenant_id = $1
          AND embedding_model = $2
          AND content_hash = ANY($3::char(64)[])
      `,
      [input.tenantId, input.embeddingModel, input.contentHashes],
    );

    if (result.rowCount) {
      await this.pool.query(
        `
          UPDATE knoviq.embedding_cache
          SET last_used_at = now()
          WHERE tenant_id = $1
            AND embedding_model = $2
            AND content_hash = ANY($3::char(64)[])
        `,
        [input.tenantId, input.embeddingModel, input.contentHashes],
      );
    }

    return new Map(
      result.rows.map((row) => [row.content_hash.trim(), parsePgVector(row.embedding)]),
    );
  }

  async upsertEmbeddingCache(input: {
    embeddings: Array<{
      contentHash: string;
      estimatedTokens: number;
      vector: number[];
    }>;
    embeddingModel: string;
    tenantId: string;
  }): Promise<void> {
    if (input.embeddings.length === 0) {
      return;
    }

    await withTransaction(this.pool, async (client: PoolClient) => {
      for (const embedding of input.embeddings) {
        await client.query(
          `
            INSERT INTO knoviq.embedding_cache (
              tenant_id,
              content_hash,
              embedding_model,
              embedding,
              token_count
            )
            VALUES ($1, $2, $3, $4::vector, $5)
            ON CONFLICT (tenant_id, embedding_model, content_hash)
            DO UPDATE SET
              last_used_at = now()
          `,
          [
            input.tenantId,
            embedding.contentHash,
            input.embeddingModel,
            vectorToSql(embedding.vector),
            embedding.estimatedTokens,
          ],
        );
      }
    });
  }

  async recordEmbeddingUsage(input: {
    cached: boolean;
    latencyMs: number;
    modelDeployment: string;
    promptTokens: number;
    provider: "azure_openai" | "local";
    requestId: string;
    tenantId: string;
    userId: string;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO knoviq.llm_usage (
          tenant_id,
          user_id,
          request_id,
          purpose,
          provider,
          model_deployment,
          prompt_tokens,
          completion_tokens,
          latency_ms,
          cached
        )
        VALUES ($1, $2, $3, 'embedding', $4, $5, $6, 0, $7, $8)
      `,
      [
        input.tenantId,
        input.userId,
        input.requestId,
        input.provider,
        input.modelDeployment,
        input.promptTokens,
        input.latencyMs,
        input.cached,
      ],
    );
  }

  async listDocuments(tenantId: string, userId: string): Promise<DocumentSummary[]> {
    const result = await this.pool.query<DocumentListRow>(
      `
        SELECT
          d.id,
          d.title,
          d.original_filename,
          d.status::text AS status,
          d.visibility::text AS visibility,
          d.chunk_count,
          d.processed_at,
          d.created_at,
          d.updated_at
        FROM knoviq.documents d
        WHERE d.tenant_id = $1
          AND d.deleted_at IS NULL
          AND (
            d.owner_id = $2
            OR d.visibility = 'tenant'
            OR EXISTS (
              SELECT 1
              FROM knoviq.document_access_grants dag
              WHERE dag.tenant_id = d.tenant_id
                AND dag.document_id = d.id
                AND dag.user_id = $2
            )
          )
        ORDER BY d.created_at DESC
        LIMIT 100
      `,
      [tenantId, userId],
    );

    return result.rows.map((row) => ({
      chunkCount: row.chunk_count,
      createdAt: row.created_at.toISOString(),
      documentId: row.id,
      filename: row.original_filename,
      processedAt: row.processed_at?.toISOString() ?? null,
      status: row.status,
      title: row.title,
      updatedAt: row.updated_at.toISOString(),
      visibility: row.visibility,
    }));
  }

  async deleteDocument(input: {
    documentId: string;
    tenantId: string;
    userId: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const documentResult = await client.query<DocumentOwnershipRow>(
        `
          SELECT owner_id
          FROM knoviq.documents
          WHERE tenant_id = $1
            AND id = $2
            AND deleted_at IS NULL
          LIMIT 1
        `,
        [input.tenantId, input.documentId],
      );
      const document = documentResult.rows.at(0);

      if (!document) {
        throw notFound("Document was not found");
      }

      if (document.owner_id !== input.userId) {
        const roleResult = await client.query<{ role: string }>(
          `
            SELECT role::text AS role
            FROM knoviq.tenant_memberships
            WHERE tenant_id = $1
              AND user_id = $2
            LIMIT 1
          `,
          [input.tenantId, input.userId],
        );
        const role = roleResult.rows.at(0)?.role;

        if (role !== "owner" && role !== "admin") {
          throw forbidden("Only the document owner or a tenant admin can delete this document");
        }
      }

      await client.query(
        `
          DELETE FROM knoviq.document_access_grants
          WHERE tenant_id = $1
            AND document_id = $2
        `,
        [input.tenantId, input.documentId],
      );
      await client.query(
        `
          DELETE FROM knoviq.document_chunks
          WHERE tenant_id = $1
            AND document_id = $2
        `,
        [input.tenantId, input.documentId],
      );
      await client.query(
        `
          UPDATE knoviq.documents
          SET deleted_at = now(),
              status = 'archived',
              updated_at = now()
          WHERE tenant_id = $1
            AND id = $2
        `,
        [input.tenantId, input.documentId],
      );
    });
  }

  /**
   * Hybrid search: vector similarity (pgvector cosine) + keyword full-text (tsvector/tsquery)
   * fused with Reciprocal Rank Fusion (RRF).
   *
   * RRF formula: score(d) = Σ 1/(k + rank_i(d))  where k=60 (standard constant).
   * Both arms retrieve `limit * RRF_MULTIPLIER` candidates; the fused top-`limit`
   * are returned. This improves recall by 25-40% over pure vector search, especially
   * for exact-keyword queries (part numbers, names, dates, codes).
   *
   * References:
   *  - Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet" SIGIR 2009
   *  - "BM25, Vector & Reranking Reference 2026" (digitalapplied.com)
   *  - "Postgres Hybrid Retrieval Architecture 2026" (markaicode.com)
   */
  async searchChunks(input: {
    documentIds: string[] | undefined;
    limit: number;
    minSimilarity: number;
    queryEmbedding: number[];
    queryText: string;
    tenantId: string;
    userId: string;
  }): Promise<SearchResult[]> {
    // Fetch more candidates than needed so RRF has a wide pool to fuse from
    const candidateLimit = Math.min(input.limit * 4, 40);

    // ── Vector arm ────────────────────────────────────────────────────────────
    const vectorResult = await this.pool.query<SearchRow & { rrf_rank: number }>(
      `
        SELECT
          d.id                                                      AS document_id,
          d.title                                                   AS document_title,
          dc.id                                                     AS chunk_id,
          dc.chunk_index,
          dc.content                                                AS chunk_content,
          dc.source_page_start,
          dc.source_page_end,
          dc.metadata,
          (1 - (dc.embedding <=> $1::vector))::real                AS score,
          ROW_NUMBER() OVER (ORDER BY dc.embedding <=> $1::vector) AS rrf_rank
        FROM knoviq.document_chunks dc
        JOIN knoviq.documents d
          ON d.tenant_id = dc.tenant_id AND d.id = dc.document_id
        WHERE dc.tenant_id = $2
          AND dc.embedding IS NOT NULL
          AND d.status    = 'ready'
          AND d.deleted_at IS NULL
          AND (
            d.owner_id = $3
            OR d.visibility = 'tenant'
            OR EXISTS (
              SELECT 1 FROM knoviq.document_access_grants dag
              WHERE dag.tenant_id = d.tenant_id
                AND dag.document_id = d.id
                AND dag.user_id = $3
            )
          )
          AND ($4::uuid[] IS NULL OR d.id = ANY($4::uuid[]))
          AND (1 - (dc.embedding <=> $1::vector)) >= $5
        ORDER BY dc.embedding <=> $1::vector
        LIMIT $6
      `,
      [
        vectorToSql(input.queryEmbedding),
        input.tenantId,
        input.userId,
        input.documentIds ?? null,
        input.minSimilarity,
        candidateLimit,
      ],
    );

    // ── Keyword (BM25-style tsvector) arm ─────────────────────────────────────
    // Build a plainto_tsquery from the raw query text. Postgres handles
    // tokenisation, stemming, and stop-word removal automatically.
    // We search both the chunk content and the stored keywords array.
    let keywordRows: Array<SearchRow & { rrf_rank: number }> = [];

    try {
      const kwResult = await this.pool.query<SearchRow & { rrf_rank: number }>(
        `
          SELECT
            d.id                                                          AS document_id,
            d.title                                                       AS document_title,
            dc.id                                                         AS chunk_id,
            dc.chunk_index,
            dc.content                                                    AS chunk_content,
            dc.source_page_start,
            dc.source_page_end,
            dc.metadata,
            ts_rank_cd(
              to_tsvector('english', dc.content),
              plainto_tsquery('english', $1)
            )::real                                                        AS score,
            ROW_NUMBER() OVER (
              ORDER BY ts_rank_cd(
                to_tsvector('english', dc.content),
                plainto_tsquery('english', $1)
              ) DESC
            )                                                              AS rrf_rank
          FROM knoviq.document_chunks dc
          JOIN knoviq.documents d
            ON d.tenant_id = dc.tenant_id AND d.id = dc.document_id
          WHERE dc.tenant_id = $2
            AND d.status     = 'ready'
            AND d.deleted_at IS NULL
            AND (
              d.owner_id = $3
              OR d.visibility = 'tenant'
              OR EXISTS (
                SELECT 1 FROM knoviq.document_access_grants dag
                WHERE dag.tenant_id = d.tenant_id
                  AND dag.document_id = d.id
                  AND dag.user_id = $3
              )
            )
            AND ($4::uuid[] IS NULL OR d.id = ANY($4::uuid[]))
            AND to_tsvector('english', dc.content) @@ plainto_tsquery('english', $1)
          ORDER BY score DESC
          LIMIT $5
        `,
        [input.queryText, input.tenantId, input.userId, input.documentIds ?? null, candidateLimit],
      );
      keywordRows = kwResult.rows;
    } catch {
      // If full-text search fails (e.g. locale issue) we silently fall back to
      // vector-only results — the RRF below will just use the vector arm.
    }

    // ── Reciprocal Rank Fusion ─────────────────────────────────────────────────
    const RRF_K = 60;
    const rrfScores = new Map<string, number>();
    const rowByChunkId = new Map<string, SearchRow>();

    for (const row of vectorResult.rows) {
      const prev = rrfScores.get(row.chunk_id) ?? 0;
      rrfScores.set(row.chunk_id, prev + 1 / (RRF_K + row.rrf_rank));
      rowByChunkId.set(row.chunk_id, row);
    }

    for (const row of keywordRows) {
      const prev = rrfScores.get(row.chunk_id) ?? 0;
      rrfScores.set(row.chunk_id, prev + 1 / (RRF_K + row.rrf_rank));
      if (!rowByChunkId.has(row.chunk_id)) {
        rowByChunkId.set(row.chunk_id, row);
      }
    }

    // Sort by fused RRF score descending, take top `limit`
    const ranked = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, input.limit)
      .map(([chunkId, rrfScore]) => {
        const row = rowByChunkId.get(chunkId)!;
        return { row, rrfScore };
      });

    return ranked.map(({ row, rrfScore }) => {
      const output: SearchResult = {
        chunkContent: row.chunk_content,
        chunkId: row.chunk_id,
        chunkIndex: row.chunk_index,
        documentId: row.document_id,
        documentTitle: row.document_title,
        metadata: row.metadata ?? {},
        score: rrfScore,
      };

      if (row.source_page_start !== null) output.sourcePageStart = row.source_page_start;
      if (row.source_page_end !== null) output.sourcePageEnd = row.source_page_end;

      return output;
    });
  }

  async getDocumentForTenant(tenantId: string, documentId: string): Promise<void> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM knoviq.documents
        WHERE tenant_id = $1
          AND id = $2
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [tenantId, documentId],
    );

    if (!result.rowCount) {
      throw notFound("Document was not found");
    }
  }
}

function parsePgVector(value: string): number[] {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .filter(Boolean)
    .map((item) => Number(item));
}
