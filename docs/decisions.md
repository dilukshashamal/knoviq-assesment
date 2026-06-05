# Architecture Decisions

Each decision below explains what was chosen, why, and what the tradeoff is.

---

## Microservices with a monorepo

**Decision:** Five independently deployed services, all source code in one git repository.

**Why microservices:** Each service has a distinct bounded context, a separate deployment
lifecycle, and independent scaling requirements. The AI Gateway can be scaled to handle chat load
without touching the Auth Service. The Knowledge Service can be upgraded with new embedding models
without rebuilding the rest of the platform.

**Why monorepo:** Shared TypeScript packages (`@knoviq/contracts`, `@knoviq/ai`,
`@knoviq/database`) need to be in sync across all services. A monorepo makes atomic cross-service
changes land in one pull request and eliminates version drift. This is the same pattern used by
Google, Uber, and Meta — monorepo is a code organisation choice, not an architecture choice.

**Tradeoff:** Build times grow with the codebase. Mitigated by Turborepo caching — only changed
packages rebuild. Any service can be extracted into its own repository without changing its HTTP
interface.

---

## PostgreSQL + pgvector instead of a dedicated vector database

**Decision:** Embeddings stored in `document_chunks.embedding::vector` using the pgvector
extension, not a separate service like Pinecone, Qdrant, or Weaviate.

**Why:** No additional infrastructure to operate. Full SQL joins between vector search and
relational data — tenant isolation, visibility filters, and document status checks happen in one
query. Transactional consistency: a document is either fully ingested with all chunks and vectors,
or rolled back. At typical enterprise document volumes, PostgreSQL with HNSW performs excellently.

**Tradeoff:** pgvector's HNSW index is less mature than purpose-built vector databases at extreme
scale (100M+ vectors). If scale demands it, the search layer can be extracted to a dedicated
vector store; the Knowledge Service's `searchChunks` method is the only place that needs to change.

---

## Hybrid BM25 + vector search with Reciprocal Rank Fusion

**Decision:** Run PostgreSQL `tsvector` keyword search and `pgvector` cosine similarity search in
parallel, fuse with RRF.

**Why:** Pure vector search misses exact keyword matches (invoice numbers, names, dates, product
codes). Pure BM25 misses semantic similarity (paraphrasing, synonyms, multi-word concepts). RRF is
rank-only — it avoids the score-incompatibility problem that breaks naively-weighted score fusion.
Research shows recall improving from ~65% to ~91% recall@10 over either arm alone (Cormack et al.,
SIGIR 2009).

**Tradeoff:** Two database queries per search instead of one. In practice this adds 5–10ms —
negligible compared to the 300–800ms LLM calls that follow.

---

## LLM reranking with a fast model

**Decision:** After RRF, use `AZURE_OPENAI_CHAT_DEPLOYMENT_FAST` (gpt-4o-mini) to score each
candidate 0–10 for relevance and keep the top-K.

**Why:** Bi-encoder embeddings encode query and document independently. An LLM jointly attends to
both, catching paraphrasing and subtle relevance that cosine similarity misses — the classic
cross-encoder advantage. Batching all candidates into one prompt keeps the cost at O(1) API calls
per search regardless of pool size.

**Tradeoff:** ~300–500ms added latency and one extra API call per search. Disable with
`KNOWLEDGE_RERANK_ENABLED=false` when latency is the priority.

---

## Dynamic chunk limit, not a hardcoded count

**Decision:** `KNOWLEDGE_SEARCH_LIMIT` defaults to 8. It is configurable and the agent overrides
it to `-1` (all chunks) for invoice workflows.

**Why:** A fixed limit of 5 is too restrictive for multi-part questions, long documents, and
financial analysis. A fixed limit of 20 sends too much context — the LLM "lost in the middle"
effect (Liu et al., 2023) reduces answer quality beyond ~15 chunks. The default of 8 balances
coverage and precision for general enterprise Q&A. Invoice workflows override the limit explicitly
because they need all available chunks regardless of similarity score.

**Tradeoff:** Higher limits increase cost and latency proportionally. The reranker already reduces
the candidate pool to the most relevant chunks before they reach the synthesizer.

---

## LLM-based invoice extraction instead of regex

**Decision:** Use `gpt-4o-mini` to extract structured invoice fields from document text, not a set
of regular expressions.

**Why:** Regex works only for one known document layout. Real-world invoices come in dozens of
formats — expense tables, labeled PDFs, receipts, purchase orders, multi-currency reports. An LLM
handles all formats without format-specific code. The LLM is instructed to extract only values
explicitly present in the text and to use the document's own verified total line as the
authoritative grand total.

**Tradeoff:** One additional API call per invoice extraction (~300ms). Falls back gracefully to a
regex grand-total extractor if Azure is unavailable — the pipeline never hard-fails.

---

## KB-first planning with a mandatory retrieval safety net

**Decision:** The planner is instructed to always call `knowledge.retrieve` for any factual
question. A safety net in `AgentRunner` injects a retrieval call if the LLM planner returns zero
tool calls for a non-greeting message.

**Why:** Without explicit instruction, the LLM planner sometimes decides to answer from training
data instead of the knowledge base. For an enterprise knowledge assistant, this is the wrong
default — the user uploaded documents precisely so the system would answer from them. The safety
net is a deterministic code-level guard, not an LLM instruction, so it cannot be bypassed by
prompt variations.

**Tradeoff:** Retrieval runs on messages where the knowledge base has nothing relevant. The
synthesizer then says "I searched your documents but found nothing." This is a better failure mode
than silently answering from LLM training data.

---

## Validator trusts chunks over its own judgment

**Decision:** When `knowledge.retrieve` returned real chunks, the answer passes through even if
the LLM validator marks it `partially_grounded` or `unsupported`. The hard block fires only when
zero chunks were retrieved.

**Why:** The LLM validator can incorrectly mark a correct answer as unsupported when the
synthesizer's phrasing is a paraphrase of the chunk text rather than verbatim. Raw RRF scores (in
the `0.001` range) are excluded from the validator input to prevent them from being misread as low
relevance. Completely suppressing correct, chunk-backed answers creates a worse user experience
than a soft caveat note.

**Tradeoff:** Occasionally a `partially_grounded` answer with minor over-generalisation passes
through with only a soft note. This is acceptable — the chunk citations are visible and auditable,
and the admin quality review inbox surfaces these for human triage.

---

## Admin quality review inbox backed by message metadata

**Decision:** Answer quality incidents are derived from `messages.metadata` JSONB rather than a
separate audit table.

**Why:** The AI Gateway already stores the full agent trace (tool calls, validation result, draft
answer) in `messages.metadata` for every assistant response. Reading from this existing column
avoids schema additions. The `answer_quality_incidents` SQL operation joins messages with
conversations and users, computes priority from validation status, and extracts the preceding user
question via a lateral join.

**Tradeoff:** Metadata schema changes in the agent runner are not reflected in historical incident
rows. This is acceptable — incidents are a 30-day rolling window; old rows with a different schema
are naturally aged out.

---

## Per-user chat thread isolation in localStorage

**Decision:** Chat threads are stored under `knoviq.chatThreads.<userId>` in `localStorage`,
not a single shared key.

**Why:** A fixed key meant that when a different user logged in on the same browser, they saw the
previous user's full chat history — a privacy violation. Scoping by `userId` ensures complete
isolation. Thread state is reset to a blank slate on every sign-in and sign-out.

**Tradeoff:** If a user clears their browser storage or uses incognito mode, thread history is
lost. This is acceptable for a client-side cache — conversation history is also stored server-side
in the database and could be loaded from the API in a future enhancement.

---

## Per-model cost estimation in the observability package

**Decision:** `@knoviq/observability.estimateLlmCostUsd` maintains a built-in pricing table keyed
by deployment name substring. The global env var rates are a fallback for unknown deployments.

**Why:** Using a single blended rate for all models (`gpt-4o-mini` rate) caused `gpt-4o` synthesis
calls to be underestimated by ~16×. `gpt-4o` costs $0.0025/$0.01 per 1k tokens versus gpt-4o-mini
at $0.00015/$0.0006. The built-in table is the single source of truth for pricing — no need to
set env vars for known models. The admin cost display also computes cost client-side from the same
table to correctly show historical rows that were written with zero cost.

**Tradeoff:** Pricing table requires manual updates when Azure changes rates. The table is in one
file (`packages/observability/src/index.ts`) so updates are straightforward.

---

## Publish-after-commit Kafka events

**Decision:** Domain events are published to Kafka after PostgreSQL writes succeed. Kafka failure
does not affect user requests.

**Why:** Simplicity. The request path never depends on Kafka availability. PostgreSQL is always the
source of truth. Kafka client improvements (reconnect on disconnect, error logging, production
topic guard) make this reliable without atomicity.

**Tradeoff:** The write and publish are not atomic. If a service writes to PostgreSQL and crashes
before the Kafka publish, the event is silently lost. For exactly-once guarantees, implement a
transactional outbox: write an event row in the same database transaction, then have a relay worker
publish it to Kafka and mark it sent.

---

## Short-lived JWT access + opaque refresh tokens

**Decision:** 15-minute JWTs verified locally in each service via shared `JWT_ACCESS_SECRET`.
Opaque refresh tokens stored as HMAC-SHA256 hashes in PostgreSQL with rotation on every use.

**Why:** No network hop to the Auth Service on every request — services verify tokens locally with
the shared secret. Refresh rotation limits replay window for stolen tokens. Logout is immediate —
the hash is deleted from PostgreSQL.

**Tradeoff:** All services share `JWT_ACCESS_SECRET`. Rotating the secret requires a coordinated
restart of all services. For production hardening, replace with asymmetric signing — distribute
the public key to each service and keep the private key only in the Auth Service.
