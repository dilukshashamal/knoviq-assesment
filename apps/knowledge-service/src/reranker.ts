/**
 * LLM Reranker
 *
 * After hybrid BM25+vector retrieval and RRF fusion, this module uses the
 * AZURE_OPENAI_CHAT_DEPLOYMENT_FAST model to re-score each candidate chunk
 * against the original query and return the top-k most relevant ones.
 *
 * WHY:
 *  - Vector bi-encoders and BM25 both encode query and document independently.
 *    An LLM (acting as a cross-encoder proxy) can jointly attend to both and
 *    detect subtle semantic relevance that embeddings miss.
 *  - This is cheaper than full LLM inference — we only pass short chunk snippets,
 *    not full generation prompts.
 *
 * APPROACH (Pointwise LLM Reranking):
 *  We batch all candidates into a SINGLE prompt asking the model to rate each
 *  chunk 0-10 for relevance to the query. This costs one API call regardless of
 *  the number of candidates (up to 20).
 *
 *  If the LLM call fails for any reason (network, quota, malformed JSON), we
 *  silently fall back to the original RRF-ranked order — reranking is always
 *  additive, never breaking.
 *
 * References:
 *  - "RAG Reranking: Improving Retrieval Quality with Cross-Encoders" (bigdataboutique.com, 2026)
 *  - "Reranking in RAG: Cross-Encoders, Cohere Rerank & FlashRank" (medium.com, 2026)
 *  - "Why Most RAG Pipelines Skip the Most Important Layer" (tianpan.co, 2026)
 */

import { AzureOpenAI } from "openai";
import { z } from "zod";

import type { KnowledgeSettings } from "./config.js";
import type { SearchResult } from "./types.js";

// Zod schema for the reranker response
const RerankResponseSchema = z.object({
  rankings: z.array(
    z.object({
      chunkId: z.string(),
      relevance: z.number().min(0).max(10),
    }),
  ),
});

export interface Reranker {
  rerank(query: string, candidates: SearchResult[], topK: number): Promise<SearchResult[]>;
}

export function createReranker(settings: KnowledgeSettings): Reranker {
  if (
    !settings.rerankEnabled ||
    !settings.azureOpenAiEndpoint ||
    !settings.azureOpenAiApiKey ||
    !settings.azureOpenAiChatDeploymentFast
  ) {
    return new PassthroughReranker();
  }

  return new LlmReranker(settings);
}

/** No-op reranker: returns candidates in their original RRF order */
class PassthroughReranker implements Reranker {
  async rerank(
    _query: string,
    candidates: SearchResult[],
    topK: number,
  ): Promise<SearchResult[]> {
    return candidates.slice(0, topK);
  }
}

class LlmReranker implements Reranker {
  private readonly client: AzureOpenAI;
  private readonly deployment: string;

  constructor(private readonly settings: KnowledgeSettings) {
    this.deployment = settings.azureOpenAiChatDeploymentFast!;
    this.client = new AzureOpenAI({
      apiKey: settings.azureOpenAiApiKey,
      apiVersion: settings.azureOpenAiApiVersion,
      endpoint: settings.azureOpenAiEndpoint,
      maxRetries: 1,
      timeout: 20_000,
    });
  }

  async rerank(query: string, candidates: SearchResult[], topK: number): Promise<SearchResult[]> {
    if (candidates.length === 0) return [];
    if (candidates.length <= topK) return candidates;

    try {
      // Build a compact candidate list for the prompt
      const candidateList = candidates.map((c, idx) => ({
        id: c.chunkId,
        index: idx + 1,
        // Truncate content to keep prompt size manageable — first 400 chars is enough
        snippet: c.chunkContent.slice(0, 400),
        source: c.documentTitle,
      }));

      const response = await this.client.chat.completions.create({
        messages: [
          {
            role: "system",
            content: [
              'You are a relevance scoring engine. Given a user query and a list of document chunks, score each chunk 0-10 for relevance to the query.',
              '0 = completely irrelevant, 10 = directly and fully answers the query.',
              'Return ONLY strict JSON: {"rankings":[{"chunkId":"...","relevance":0-10},...]}',
              'Score ALL chunks. Do not add explanations.',
            ].join('\n'),
          },
          {
            role: "user",
            content: JSON.stringify({ query, chunks: candidateList }),
          },
        ],
        model: this.deployment,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 800,
      });

      const content = response.choices.at(0)?.message.content;
      if (!content) return candidates.slice(0, topK);

      const parsed = RerankResponseSchema.parse(JSON.parse(content));

      // Build a score map
      const scoreMap = new Map(
        parsed.rankings.map((r) => [r.chunkId, r.relevance]),
      );

      // Sort candidates by LLM relevance score descending, then RRF score as tiebreak
      const reranked = [...candidates].sort((a, b) => {
        const scoreA = scoreMap.get(a.chunkId) ?? 0;
        const scoreB = scoreMap.get(b.chunkId) ?? 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return b.score - a.score; // RRF score tiebreak
      });

      return reranked.slice(0, topK);
    } catch {
      // Graceful fallback: use RRF ordering
      return candidates.slice(0, topK);
    }
  }
}
