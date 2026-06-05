# RAG Pipeline

Knoviq implements a production-grade Retrieval-Augmented Generation pipeline across the Knowledge
Service and AI Gateway. The pipeline has three stages: ingestion, retrieval, and answer generation.

---

## Stage 1 — Document Ingestion

When a user uploads a document, the Knowledge Service runs the following steps before marking the
document `ready`.

```
Upload (PDF or TXT)
        │
        ▼
  1. Deduplication
     SHA-256 hash of file buffer.
     Reject if identical file already exists for this tenant.
        │
        ▼
  2. Text Extraction
     PDF  →  pdf-parse library, per-page text, empty pages filtered
     TXT  →  UTF-8 decode, whitespace normalised
        │
        ▼
  3. Hybrid Chunking  (three-tier strategy)
     │
     ├── Tier 1: Structural splits
     │   Cut at markdown headings (#, ##, …), ALL-CAPS section titles,
     │   horizontal rules, and 2+ consecutive blank lines.
     │   Headings always start their own chunk — preserves semantic anchors.
     │
     ├── Tier 2: Semantic sliding window
     │   Within each structural section, sentences are detected by
     │   ". ", "? ", "! " followed by uppercase, and by newlines.
     │   Window grows sentence-by-sentence until it approaches chunkTargetChars.
     │   Overlap of chunkOverlapChars worth of sentences carried into next chunk.
     │   Cross-sentence answers are never lost at a boundary.
     │
     └── Tier 3: Keyword extraction
         Top-10 TF tokens (stop-words removed) stored in chunk metadata.
         Feeds the BM25 full-text search arm at query time.
        │
        ▼
  4. Embedding
     Azure text-embedding-3-small via Azure OpenAI SDK.
     Checks embedding_cache by content hash first — identical chunks
     across documents never hit the API twice.
     Fallback: deterministic local vectors for development without Azure.
        │
        ▼
  5. Persist
     knoviq.documents  →  status: 'ready', chunk_count, token_count
     knoviq.document_chunks  →  content + embedding::vector per chunk
     knoviq.embedding_cache  →  content_hash → vector (reusable)
        │
        ▼
  6. Publish
     knowledge.document.uploaded  →  Kafka knoviq.documents topic
```

### Configuration

| Variable                        | Default    | Effect                                              |
| ------------------------------- | ---------- | --------------------------------------------------- |
| `KNOWLEDGE_CHUNK_TARGET_CHARS`  | `1800`     | Target characters per chunk                         |
| `KNOWLEDGE_CHUNK_OVERLAP_CHARS` | `250`      | Sentence overlap between consecutive chunks         |
| `KNOWLEDGE_EMBEDDING_PROVIDER`  | `azure`    | `azure` for production, `local` for dev smoke tests |
| `KNOWLEDGE_MAX_FILE_BYTES`      | `10485760` | 10 MB upload limit                                  |

---

## Stage 2 — Hybrid Retrieval

When the agent calls `knowledge.retrieve`, the Knowledge Service runs two search arms in parallel
and fuses their results.

```
Query text
    │
    ├─── Embed query ──────────────────────────────────────────────────┐
    │    Azure text-embedding-3-small                                   │
    │                                                                   ▼
    │                                              Vector arm (pgvector cosine)
    │                                              SELECT … FROM document_chunks
    │                                              ORDER BY embedding <=> query_vec
    │                                              WHERE tenant_id = $1
    │                                                AND similarity >= min_threshold
    │                                              LIMIT candidate_pool
    │
    └─── Keyword arm ──────────────────────────────────────────────────┐
         PostgreSQL tsvector full-text search                           │
         plainto_tsquery('english', query)                              │
         ts_rank_cd(to_tsvector('english', content), tsquery)          │
         LIMIT candidate_pool                                           │
                                                                        ▼
                                              Reciprocal Rank Fusion (RRF)
                                              score(d) = Σ 1 / (60 + rank_i(d))
                                              Fuses both ranked lists rank-only,
                                              avoiding score incompatibility.
                                              Pool: up to 40 candidates.
                                                        │
                                                        ▼
                                              LLM Reranking
                                              AZURE_OPENAI_CHAT_DEPLOYMENT_FAST
                                              Batch-scores all candidates 0–10
                                              for relevance to the query.
                                              One API call regardless of pool size.
                                              Falls back to RRF order on failure.
                                                        │
                                                        ▼
                                              Top-K chunks returned (default K=8)
                                              Each result: chunkContent, chunkId,
                                              documentTitle, score, sourcePageStart
```

### Why hybrid search

Pure vector search misses exact keyword matches — invoice numbers, part codes, names, dates. Pure
BM25 misses semantic similarity — paraphrased questions, synonyms, multi-word concepts. Running
both arms and fusing with RRF captures both. Research shows recall improving from ~65% to ~91%
recall@10 over either arm alone (Cormack et al., SIGIR 2009).

### Why LLM reranking

Bi-encoder embeddings encode query and document independently. An LLM jointly attends to both,
detecting paraphrasing and subtle relevance that cosine similarity misses. Batching all candidates
into one prompt keeps the cost at O(1) API calls per search.

### Chunk limit tuning

The default `KNOWLEDGE_SEARCH_LIMIT=8` is a balanced production default.

| Value | Use case                                                  |
| ----- | --------------------------------------------------------- |
| 5     | Fast, lowest cost — good for simple factual Q&A           |
| 8     | Balanced default — covers multi-part questions            |
| 10    | Document summarisation or broad policy queries            |
| 15+   | Invoice/financial workflows (already overridden in agent) |

Beyond ~15 chunks, the LLM "lost in the middle" effect reduces answer quality — the model attends
poorly to content in the middle of a long context window.

### Configuration

| Variable                             | Default | Effect                                               |
| ------------------------------------ | ------- | ---------------------------------------------------- |
| `KNOWLEDGE_SEARCH_MIN_SIMILARITY`    | `0.2`   | Minimum cosine similarity for vector arm             |
| `KNOWLEDGE_SEARCH_LIMIT`             | `8`     | Final chunks returned to the agent                   |
| `KNOWLEDGE_RERANK_CANDIDATES`        | `24`    | Candidate pool fed into LLM reranker (3–4× limit)    |
| `KNOWLEDGE_RERANK_ENABLED`           | `true`  | Set `false` to skip reranking (faster, less precise) |
| `KNOWLEDGE_SEARCH_CACHE_TTL_SECONDS` | `60`    | Redis cache TTL for search results                   |

---

## Stage 3 — Answer Generation

After retrieval, the AI Gateway synthesizes a grounded answer.

```
Retrieved chunks (with citations)
        │
        ▼
  Synthesizer (gpt-4o, temp=0.1)
  Receives:
    - User message
    - Retrieved chunks as numbered, labelled evidence (no raw RRF scores)
    - Other tool outputs (calculator, invoice extraction)
  Produces:
    - Answer grounded in chunk content
    - Cites document title and chunk ID for each claim
        │
        ▼
  Validator (gpt-4o-mini, temp=0)
  Receives:
    - Draft answer
    - Actual retrieved chunk snippets (up to 600 chars each)
    - requiresGroundedEvidence flag
  Checks:
    - Are all factual claims in the answer present in the retrieved chunks?
    - Paraphrase counts as grounded — only clearly absent facts are flagged
  Returns: grounded / partially_grounded / unsupported
        │
        ▼
  Guardrail
  ├── grounded            → return answer as-is
  ├── partially_grounded  → return answer (chunks exist, trust the content)
  ├── unsupported + chunks exist → soft caveat appended, answer kept
  └── unsupported + no chunks   → answer replaced with "not found" message
```

### KB-first rule

The planner is instructed to always call `knowledge.retrieve` for any factual, informational, or
who/what/when/how/why question. The knowledge base is the primary source of truth.

A mandatory safety net in `AgentRunner` injects a retrieval call if the LLM planner returns zero
tool calls for a non-greeting message. This is a deterministic code-level guard — it cannot be
bypassed by prompt variations.

### Validator design

The validator prompt explicitly instructs the LLM not to mark answers `unsupported` when the
retrieved chunks contain the topic — even if the topic appears as a proper noun or product name
within a sentence rather than as a heading. Raw RRF scores (which are in the `0.001` range) are
intentionally excluded from the validator input to prevent the LLM from treating them as evidence
of low relevance.

---

## Search Cache

Search results are cached in Redis by a hash of
`(tenantId, userId, query, limit, minSimilarity, documentIds)`. When a user uploads a new document,
the Knowledge Service invalidates all of that user's search keys for the tenant.

Set `KNOWLEDGE_SEARCH_CACHE_TTL_SECONDS=0` to disable result caching while keeping Redis available
for other services.
