# Knoviq — Enterprise AI Knowledge Assistant

Knoviq is a production-ready, multi-tenant AI knowledge assistant. Users upload PDF and TXT documents into a private knowledge base, then chat with an AI that retrieves, cites, and synthesises answers strictly from those documents. Five independent microservices handle authentication, AI orchestration, document knowledge management, tool execution, and the web frontend — all in one monorepo.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Setup Instructions](#2-setup-instructions)
3. [Environment Variables](#3-environment-variables)
4. [RAG Pipeline](#4-rag-pipeline)
5. [Tool Calling Flow](#5-tool-calling-flow)
6. [Scaling Considerations](#6-scaling-considerations)
7. [Architecture Decisions & Tradeoffs](#7-architecture-decisions--tradeoffs)
8. [API Reference](#8-api-reference)
9. [Deployment](#9-deployment)

---

## 1. Architecture Overview

### Service Map

```
┌─────────────────────────────────────────────────────────────────┐
│                       Browser / Client                          │
│                    Next.js 15  (port 3000)                      │
└────────────────┬───────────────────────────┬────────────────────┘
                 │  /api/auth/*              │  /api/chat
                 │  /api/documents           │  /api/chat/stream
                 ▼                           ▼
   ┌─────────────────────┐       ┌─────────────────────────┐
   │    Auth Service     │       │      AI Gateway         │
   │    port 4001        │       │      port 4002          │
   │                     │       │                         │
   │  Register / Login   │◄─JWT──│  Planner Agent          │
   │  JWT issuance       │ verify│  Tool Agents            │
   │  Refresh / Logout   │       │  Synthesizer Agent      │
   │  Tenant / RBAC      │       │  Validator Agent        │
   └─────────────────────┘       └──────────┬──────────────┘
                                             │  HTTP
                           ┌─────────────────┤
                           │                 │
              ┌────────────▼──────┐  ┌───────▼──────────────┐
              │ Knowledge Service │  │ Tool Execution Svc   │
              │ port 4003         │  │ port 4004            │
              │                   │◄─│                      │
              │ PDF/TXT ingest    │  │ knowledge.retrieve   │
              │ Hybrid chunking   │  │ calculator.evaluate  │
              │ Azure embeddings  │  │ sql.query_safe       │
              │ BM25 + vector     │  │ extract_invoice_     │
              │ LLM reranking     │  │   fields             │
              └─────────┬─────────┘  └──────────────────────┘
                        │
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
   ┌────────────┐ ┌──────────┐ ┌────────────┐
   │ PostgreSQL │ │  Redis   │ │   Kafka    │
   │ + pgvector │ │ (cache)  │ │  (events)  │
   └────────────┘ └──────────┘ └────────────┘
```

### Monorepo Layout

```
apps/
  auth-service/            JWT auth, user/tenant management         port 4001
  ai-gateway/              Multi-agent chat orchestration           port 4002
  knowledge-service/       Document ingestion, hybrid RAG search    port 4003
  tool-execution-service/  Calculator, SQL, retrieval, invoices     port 4004
  web/                     Next.js 15 App Router frontend           port 3000

packages/
  @knoviq/ai               ToolName enum, shared AI types
  @knoviq/auth             JWT verification helpers
  @knoviq/cache            Redis client (TTL helpers, no-op fallback)
  @knoviq/config           Zod-validated environment loader
  @knoviq/contracts        Shared API schemas (health, errors, roles)
  @knoviq/database         pg Pool factory + withTransaction helper
  @knoviq/events           Kafka domain event publisher + disabled fallback
  @knoviq/observability    OpenTelemetry spans, createTimer, LLM cost estimation

infra/
  docker/                  Shared multi-stage backend.Dockerfile
  k8s/                     Kubernetes base manifests + kustomize overlays
  migrations/              PostgreSQL schema migrations

docs/
  architecture.md          Service diagram and data boundary reference
  decisions.md             Full ADR log (13 decisions)
```

**Key design principle:** each backend service is its own Fastify process with its own `pg.Pool` and Docker image. Shared packages are compile-time-only — no runtime coupling between services.

### Data Ownership

No service reads from another service's database tables. All cross-service access goes through HTTP.

| Service        | Owns tables                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| Auth           | `tenants`, `users`, `tenant_memberships`, `refresh_tokens`, `audit_logs`     |
| Knowledge      | `documents`, `document_access_grants`, `document_chunks`, `embedding_cache`  |
| AI Gateway     | `conversations`, `messages`, `message_citations`, `llm_usage`                |
| Tool Execution | `tool_executions`                                                            |
| All services   | `service_metrics` (each writes its own rows)                                 |

---

## 2. Setup Instructions

### Prerequisites

| Requirement             | Version                          |
| ----------------------- | -------------------------------- |
| Node.js                 | `≥ 20.9` (`22.x` recommended)    |
| pnpm (via Corepack)     | `10.13.1`                        |
| Docker Desktop / Engine | `≥ 24`                           |
| Azure OpenAI resource   | Required for embeddings and chat |

### First-time local setup

```bash
# 1. Enable pnpm via Corepack
corepack enable
corepack prepare pnpm@10.13.1 --activate

# 2. Install all workspace dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env — fill in AZURE_OPENAI_* values and JWT secrets (see §3)

# 4. Start infrastructure (Postgres on port 55432, Redis, Kafka)
docker compose up -d postgres redis kafka

# 5. Build all packages and services
pnpm build

# 6. Start each backend service in separate terminals
pnpm --filter @knoviq/auth-service start            # port 4001
pnpm --filter @knoviq/ai-gateway start              # port 4002
pnpm --filter @knoviq/knowledge-service start       # port 4003
pnpm --filter @knoviq/tool-execution-service start  # port 4004

# 7. Start the web frontend
pnpm --filter @knoviq/web dev                       # port 3000
```

Open `http://localhost:3000`, register an account, upload a document, and start chatting.

### Development mode (hot reload)

Replace `start` with `dev` for any backend service. `dev` uses `tsx watch` and picks up `.ts` changes without restarting. `start` runs from compiled `dist/` — after source changes rebuild with `pnpm build` first.

```bash
pnpm --filter @knoviq/ai-gateway dev
```

### Database migrations

Migrations apply automatically when the Postgres container starts via the `docker-entrypoint-initdb.d` mount. To re-apply manually:

```bash
docker compose run --rm migrations
```

### Full Docker stack

To run all five services in Docker (useful for integration testing):

```bash
docker compose --profile app up -d
```

This builds each service image from `infra/docker/backend.Dockerfile` and starts everything in the correct dependency order.

### Invoice smoke test

```bash
pnpm smoke:invoice
```

Builds the repo, starts all four backend services, uploads a sample invoice TXT, asks the agent to summarise it, and asserts the correct total — all in one command.

### CI checks

The same checks that run in GitHub Actions can be run locally:

```bash
pnpm format:check   # Prettier
pnpm build          # TypeScript compile
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
pnpm test           # Vitest
```

---

## 3. Environment Variables

Copy `.env.example` to `.env`. All configuration is validated at startup via Zod; a service will refuse to start if required variables are missing or malformed.

### Azure OpenAI (required for production)

| Variable                                 | Description                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `AZURE_OPENAI_ENDPOINT`                  | Your Azure OpenAI resource endpoint URL                                             |
| `AZURE_OPENAI_API_KEY`                   | API key for the resource                                                            |
| `AZURE_OPENAI_API_VERSION`               | API version, default `2025-04-01-preview`                                           |
| `AZURE_OPENAI_CHAT_DEPLOYMENT_FAST`      | Fast model (e.g. `gpt-4o-mini`) — used for planner, validator, reranker, invoices  |
| `AZURE_OPENAI_CHAT_DEPLOYMENT_REASONING` | Reasoning model (e.g. `gpt-4o`) — used for answer synthesis only                   |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`      | Embedding model (e.g. `text-embedding-3-small`)                                     |
| `AZURE_OPENAI_EMBEDDING_DIMENSIONS`      | Embedding dimensions, default `1536`                                                |

Set `KNOWLEDGE_EMBEDDING_PROVIDER=local` and `AI_GATEWAY_MODEL_PROVIDER=local` to skip Azure entirely (CI / local smoke tests only — not suitable for real RAG quality).

### Auth

| Variable                 | Default | Description                                     |
| ------------------------ | ------- | ----------------------------------------------- |
| `JWT_ACCESS_SECRET`      | —       | Min 32-character secret for signing access JWTs |
| `JWT_REFRESH_SECRET`     | —       | Min 32-character secret for refresh tokens      |
| `JWT_ACCESS_TTL_SECONDS` | `900`   | Access token lifetime (15 minutes)              |

### Knowledge Service tuning

| Variable                          | Default | Description                                                 |
| --------------------------------- | ------- | ----------------------------------------------------------- |
| `KNOWLEDGE_CHUNK_TARGET_CHARS`    | `1800`  | Target characters per chunk                                 |
| `KNOWLEDGE_CHUNK_OVERLAP_CHARS`   | `250`   | Overlap between consecutive chunks                          |
| `KNOWLEDGE_SEARCH_LIMIT`          | `8`     | Final number of chunks returned to the agent                |
| `KNOWLEDGE_SEARCH_MIN_SIMILARITY` | `0.2`   | Minimum cosine similarity for the vector arm                |
| `KNOWLEDGE_RERANK_ENABLED`        | `true`  | Enable LLM reranking after hybrid retrieval                 |
| `KNOWLEDGE_RERANK_CANDIDATES`     | `24`    | Candidate pool size fed into the reranker (3–4× limit)      |

Tuning guide for `KNOWLEDGE_SEARCH_LIMIT`: 5 for fast/cheap Q&A; 8 for balanced default; 10 for summarisation tasks; 15+ for financial document analysis. Beyond ~15, the LLM "lost-in-the-middle" effect reduces synthesis quality.

### Infrastructure

| Variable        | Default                  | Description                              |
| --------------- | ------------------------ | ---------------------------------------- |
| `DATABASE_URL`  | —                        | Full PostgreSQL connection string        |
| `DB_POOL_MAX`   | `10`                     | Max pg connections per service process   |
| `REDIS_URL`     | `redis://localhost:6379` | Redis connection URL                     |
| `REDIS_ENABLED` | `true`                   | Set `false` to disable caching entirely  |
| `KAFKA_ENABLED` | `true`                   | Set `false` to disable event publishing  |
| `KAFKA_BROKERS` | `127.0.0.1:29092`        | Comma-separated Kafka broker addresses   |

### LLM cost controls

| Variable                        | Default | Description                                        |
| ------------------------------- | ------- | -------------------------------------------------- |
| `LLM_DEFAULT_MAX_OUTPUT_TOKENS` | `1200`  | Hard token cap on synthesis responses              |
| `LLM_MEMORY_MAX_MESSAGES`       | `12`    | Conversation history window (older turns drop off) |
| `LLM_RATE_LIMIT_MAX_REQUESTS`   | `30`    | Per-user LLM-backed chat requests per window       |
| `LLM_RATE_LIMIT_WINDOW_SECONDS` | `60`    | Per-user LLM rate-limit window length              |

### Observability

| Variable                            | Default | Description                           |
| ----------------------------------- | ------- | ------------------------------------- |
| `OTEL_TRACES_ENABLED`               | `false` | Enable OpenTelemetry trace exporting  |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`| —       | OTLP collector endpoint URL           |

---

## 4. RAG Pipeline

The retrieval-augmented generation pipeline spans the Knowledge Service (ingestion and retrieval) and the AI Gateway (synthesis and validation). Every answer is grounded in documents the user has uploaded — the agent never answers from LLM training data for factual questions.

### 4.1 Document Ingestion

When a user uploads a PDF or TXT file, the Knowledge Service runs this pipeline synchronously:

```
User uploads PDF or TXT
         │
         ▼
  1. Deduplication
     SHA-256 hash of file bytes → reject if already uploaded (409 Conflict)

  2. Storage
     Raw file saved to ./data/uploads/<tenantId>/<documentId>/<filename>
     (Docker volume: knowledge-uploads)

  3. Text extraction
     PDF  → pdf-parse  (text + page numbers preserved)
     TXT  → UTF-8 decode

  4. Hybrid chunking  (3-tier strategy)
     ├─ Tier 1: Structural splits
     │   Splits at Markdown headings (# ## ###), ALL-CAPS title lines
     │   (≤80 chars), horizontal rules (--- === ***), and 2+ blank lines.
     │   Headings are prepended to their section so each chunk starts
     │   with its own heading — this significantly improves embedding quality.
     │
     ├─ Tier 2: Semantic sliding window
     │   Within each structural section, sentences are detected using
     │   `. `, `? `, `! ` followed by uppercase, and newline boundaries.
     │   A window grows until it would exceed KNOWLEDGE_CHUNK_TARGET_CHARS
     │   (default 1800), then emits the chunk at the last complete sentence.
     │   The next window begins with KNOWLEDGE_CHUNK_OVERLAP_CHARS (250)
     │   of context carried over from the previous chunk, so answers
     │   that span a chunk boundary are never lost.
     │
     └─ Tier 3: Keyword extraction
         Top-10 highest-TF tokens (stop-words removed) stored in
         chunk metadata.keywords — used by the BM25 full-text search
         arm at query time.

  5. Embedding
     Azure text-embedding-3-small (1536 dimensions).
     Content-hash deduplication: if an identical chunk already exists
     in embedding_cache for this tenant, the Azure API is not called
     again — the cached vector is reused. New vectors are written back
     to the cache.

  6. Persist
     INSERT INTO document_chunks (content, embedding::vector(1536), ...)
     All chunks for a document are inserted in a single transaction.
     Document marked status='ready' on success, status='failed' on error.

  7. Event
     knowledge.document.uploaded → Kafka topic: documents
```

### 4.2 Hybrid Retrieval

Every time the agent calls `knowledge.retrieve`, the Knowledge Service runs:

```
Query text
    │
    ├─► Embed query text via Azure text-embedding-3-small
    │
    ├─► Vector arm (pgvector)
    │   SELECT ... FROM document_chunks
    │   WHERE tenant_id = $1 AND (access control filters)
    │   ORDER BY embedding <=> $queryVector  -- cosine distance
    │   LIMIT rerankCandidates * 4
    │   Returns rows with RRF rank by cosine distance.
    │
    └─► BM25 arm (PostgreSQL tsvector)
        SELECT ... FROM document_chunks
        WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $query)
        ORDER BY ts_rank_cd(...) DESC
        LIMIT rerankCandidates * 4
        Falls back silently if tsvector errors (locale issues).
                   │
                   ▼
        Reciprocal Rank Fusion (RRF)
        score(chunk) = Σ  1 / (60 + rank_i)
        where rank_i is the chunk's rank in each arm that returned it.
        RRF is rank-only — avoids the score-incompatibility problem
        that breaks naively weighted cosine + BM25 score fusion.
                   │
                   ▼
        LLM Reranking  (gpt-4o-mini, if KNOWLEDGE_RERANK_ENABLED=true)
        All KNOWLEDGE_RERANK_CANDIDATES chunks (default 24) sent
        to a single batched prompt. Each chunk scored 0–10 for
        relevance to the query. Sorted by LLM score; RRF is tiebreak.
        Graceful fallback to RRF order on any LLM failure.
                   │
                   ▼
        Top KNOWLEDGE_SEARCH_LIMIT chunks (default 8)
        Cached in Redis: key = hash(tenantId, userId, query, limit, minSimilarity)
        TTL = KNOWLEDGE_SEARCH_CACHE_TTL_SECONDS (default 60s)
```

**Why hybrid search?** Pure vector search misses exact keyword matches — invoice numbers, product codes, names, and dates. Pure BM25 misses semantic similarity — paraphrasing, synonyms, multi-word concepts. Running both arms and fusing with RRF consistently improves recall@10 from ~65% (either arm alone) to ~91% (Cormack et al., SIGIR 2009).

**Why LLM reranking?** Bi-encoder embeddings encode query and document independently. An LLM jointly attends to both, acting as a cross-encoder proxy and catching subtle semantic relevance that cosine similarity misses. Batching all candidates into one prompt keeps the cost constant at O(1) API calls per search regardless of candidate pool size.

### 4.3 Invoice Workflow

When the agent detects an invoice summarisation request, it overrides the retrieval limit to `-1` (all chunks, no similarity floor) and chains three tools automatically:

```
knowledge.retrieve (limit=-1, minSimilarity=-1, invoice-focused query)
         │
         ▼  all chunks containing invoice data
document.extract_invoice_fields  (gpt-4o-mini, JSON mode)
         │
         ▼  { invoices[], grandTotal, periodLabel }
calculator.evaluate  (verifies the computed sum)
         │
         ▼
Synthesizer builds the final invoice summary with per-vendor breakdown
```

---

## 5. Tool Calling Flow

Every chat request enters `AgentRunner.run()` in the AI Gateway and executes a strict four-phase pipeline.

### 5.1 Agent Phases

```
POST /chat  (or /chat/stream for SSE, /chat/ws for WebSocket)
  { message, conversationId? }
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AgentRunner.run()                         │
│                                                                 │
│  Phase 1 — PLANNER  (gpt-4o-mini, temperature=0)                │
│  ─────────────────────────────────────────────────             │
│  Input:  last LLM_MEMORY_MAX_MESSAGES (12) conversation turns   │
│          tool definitions (fetched from Tool Execution Svc,     │
│          cached in Redis for TOOL_DEFINITIONS_CACHE_TTL_SECONDS │
│          = 300s to avoid per-request HTTP round-trips)          │
│          user message                                           │
│  Output: JSON { toolCalls: [{ toolName, arguments, reason }] }  │
│          (max 5 tool calls per planning step)                   │
│                                                                 │
│  Planning rules (system prompt):                                │
│  1. ALWAYS call knowledge.retrieve for any factual question.    │
│  2. Only skip retrieval for pure greetings and arithmetic.      │
│  3. Use calculator.evaluate for numeric expressions only.       │
│  4. Use sql.query_safe only for platform metrics / reports.     │
│                                                                 │
│  Safety net (code level, cannot be bypassed by prompt):         │
│  If planner returns 0 tool calls AND message is not a pure      │
│  greeting → inject knowledge.retrieve { limit:5, query:msg }   │
│                                                                 │
│                                                                 │
│  Phase 2 — TOOL AGENTS                                          │
│  ─────────────────────────────────────────────────             │
│  Sequential execution of each planned tool call:               │
│    POST tool-execution-service/tools/execute                    │
│    ├─ knowledge.retrieve      → Knowledge Service /search       │
│    │                            (user JWT forwarded to preserve │
│    │                             document-level access control) │
│    ├─ calculator.evaluate     → in-process recursive descent    │
│    │                            parser (no eval())              │
│    ├─ sql.query_safe          → PostgreSQL allowlisted queries  │
│    └─ extract_invoice_fields  → Azure gpt-4o-mini JSON mode     │
│                                                                 │
│  Follow-up chaining (up to 4 rounds):                           │
│  buildFollowUpToolCalls() inspects completed results and        │
│  auto-chains for invoice workflows:                             │
│    knowledge.retrieve → extract_invoice_fields → calculator     │
│                                                                 │
│                                                                 │
│  Phase 3 — SYNTHESIZER  (gpt-4o, temperature=0.1)               │
│  ─────────────────────────────────────────────────             │
│  Input:  structured chunk citations (RRF scores deliberately    │
│          omitted — 0.001-range values confuse the LLM into      │
│          thinking evidence is "0% relevant")                    │
│          other tool outputs (calculator, SQL, invoice)          │
│          last 6 conversation turns for context                  │
│  Output: grounded answer with document citations                │
│  Token cap: LLM_DEFAULT_MAX_OUTPUT_TOKENS (1200)                │
│                                                                 │
│                                                                 │
│  Phase 4 — VALIDATOR  (gpt-4o-mini, temperature=0)              │
│  ─────────────────────────────────────────────────             │
│  Scores draft answer: grounded | partially_grounded | unsupported
│                                                                 │
│  Guardrail logic (applyValidationGuardrail):                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Chunks returned?  │ Validator says   │ Action            │  │
│  │ ─────────────────────────────────────────────────────── │  │
│  │ Yes               │ grounded         │ pass through      │  │
│  │ Yes               │ partially_ground │ pass through      │  │
│  │ Yes               │ unsupported      │ soft caveat added │  │
│  │ No                │ partially_ground │ validation note   │  │
│  │ No                │ unsupported      │ answer replaced   │  │
│  └──────────────────────────────────────────────────────────┘  │
│  Rationale: LLM validator can wrongly reject a correct answer  │
│  that paraphrases chunk text. Trusting chunks over the          │
│  validator's judgment avoids silencing correct responses.       │
│                                                                 │
│  Persist: conversation, messages, tool records, LLM usage,     │
│           chunk citations (message_citations table)             │
│  Publish: agent.run.completed → Kafka topic: agent-runs         │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
  { answer, conversationId, toolCalls, validation }
```

### 5.2 Available Tools

| Tool name                         | Runs in                                  | Selected when                                        |
| --------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `knowledge.retrieve`              | Knowledge Service `/search`              | All factual, informational, policy, procedure queries |
| `calculator.evaluate`             | In-process (no `eval()`, custom parser)  | Numeric arithmetic; invoice total verification       |
| `sql.query_safe`                  | PostgreSQL — 9 read-only named operations| Usage metrics, document counts, cost/quality reports |
| `document.extract_invoice_fields` | Azure gpt-4o-mini, JSON mode             | Invoice summarisation workflows (auto-chained)       |

**`sql.query_safe` allowlisted operations:** `answer_quality_incidents`, `answer_quality_trend`, `answer_validation_summary`, `document_count`, `list_documents`, `llm_usage_summary`, `recent_tool_executions`, `service_metric_summary`, `tool_execution_summary`. The model never sends raw SQL — it picks an operation name and optional filter parameters.

### 5.3 Transport Options

All three transports emit identical structured step events: `conversation`, `agent_step`, `message`, `tool_start`, `tool_result`, `validation`, `final`.

| Endpoint            | Transport          | Use case                              |
| ------------------- | ------------------ | ------------------------------------- |
| `POST /chat`        | HTTP (synchronous) | Simple integrations, testing, scripts |
| `POST /chat/stream` | Server-Sent Events | Web frontends (what the UI uses)      |
| `GET /chat/ws`      | WebSocket          | Real-time bidirectional applications  |

### 5.4 KB-First Planning Guarantee

The planner is instructed in its system prompt to always call `knowledge.retrieve` for any factual question. A deterministic code-level safety net in `AgentRunner` injects retrieval when the LLM returns zero tool calls and the message is not a greeting. This guard sits at the TypeScript layer — it cannot be bypassed by prompt injection or model variation.

---

## 6. Scaling Considerations

### Stateless services

All four backend services hold no in-process session state. Conversation memory, tool logs, and LLM usage are persisted in PostgreSQL. Any service can be horizontally scaled behind a load balancer without sticky sessions:

```bash
kubectl scale deployment ai-gateway --replicas=5
kubectl scale deployment tool-execution-service --replicas=4
```

### PostgreSQL / pgvector

- **HNSW index** on `document_chunks.embedding` gives approximate nearest-neighbour search in sub-millisecond latency up to tens of millions of vectors. HNSW does not require periodic re-indexing like IVFFlat.
- **Embedding cache** (`knoviq.embedding_cache`) deduplicates Azure API calls by content hash. Identical text chunks across documents never re-embed.
- **Connection pooling:** Each service instance creates its own `pg.Pool` with `DB_POOL_MAX` connections. Increase this per replica in high-concurrency production environments.
- **JSONB metadata** in `messages.metadata` stores the full agent trace (tool calls, validation result) avoiding schema additions for new trace fields.

### Caching (Redis)

| What is cached                 | Key                                              | TTL     |
| ------------------------------ | ------------------------------------------------ | ------- |
| Tool definitions               | `tools:definitions:<tenantId>`                   | 300 s   |
| Hybrid search results          | `knowledge:search:<tenantId>:<userId>:<hash>`    | 60 s    |

Set `REDIS_ENABLED=false` to disable Redis entirely — a `DisabledCacheClient` no-op is used automatically with no code changes.

### Kafka event stream

Domain events (`knowledge.document.uploaded`, `conversation.created`, `agent.run.completed`, `llm.usage.recorded`, `tool.execution.completed`) are published after PostgreSQL writes commit. Downstream consumers (analytics, billing, audit) process asynchronously without coupling to the request path. Set `KAFKA_ENABLED=false` to use a `DisabledEventPublisher` — no user-facing impact.

**Current limitation:** write and Kafka publish are not in the same transaction. If a service crashes after writing to Postgres but before publishing to Kafka, the event is silently lost. For exactly-once guarantees, implement the transactional outbox pattern.

### LLM cost controls

| Mechanism          | Implementation                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Token budget       | `LLM_DEFAULT_MAX_OUTPUT_TOKENS=1200` hard cap on synthesis output                                                                           |
| Memory window      | `LLM_MEMORY_MAX_MESSAGES=12` — oldest turns drop first                                                                                      |
| Per-user throttling | `LLM_RATE_LIMIT_MAX_REQUESTS=30` per `LLM_RATE_LIMIT_WINDOW_SECONDS=60`, keyed by tenant and user after JWT auth                            |
| Rerank pool        | `KNOWLEDGE_RERANK_CANDIDATES=24` — controls how many chunks the LLM reranker scores per search                                              |
| Model routing      | Planner, validator, reranker, invoice extraction → `gpt-4o-mini`; synthesis only → `gpt-4o`                                                 |
| Per-model pricing  | `@knoviq/observability` has a built-in pricing table keyed by deployment name substring. `gpt-4o` synthesis is never charged at mini rates.  |
| Embedding cache    | Content-hash dedup prevents re-embedding identical chunks across documents                                                                  |

### Kubernetes defaults

```
auth-service:            2 replicas
ai-gateway:              2 replicas
knowledge-service:       1 replica  (upload volume is ReadWriteOnce)
tool-execution-service:  2 replicas
```

To support multiple `knowledge-service` replicas in production, move the upload volume to object storage (S3-compatible) and change the storage key to a remote URL.

---

## 7. Architecture Decisions & Tradeoffs

### Microservices in a monorepo

**Decision:** Five independently deployed services, all source in one git repository.

**Why microservices:** Each service has a distinct bounded context and independent scaling requirements. The AI Gateway scales for chat load without touching Auth. The Knowledge Service can be upgraded with new embedding models without rebuilding anything else.

**Why monorepo:** Shared TypeScript packages (`@knoviq/contracts`, `@knoviq/ai`, `@knoviq/database`) stay in sync. Atomic cross-service changes land in one PR. Turborepo caches unchanged packages so CI only rebuilds what changed.

**Tradeoff:** Build times grow as the codebase grows. Any service can be extracted to its own repository without changing its HTTP interface.

---

### PostgreSQL + pgvector instead of a dedicated vector database

**Decision:** Embeddings in `document_chunks.embedding::vector(1536)` via the pgvector extension, not Pinecone, Qdrant, or Weaviate.

**Why:** No additional infrastructure to operate. Full SQL joins between vector search and relational data — tenant isolation, access grants, and document status checks happen in one query. Transactional consistency: a document is either fully ingested with all chunks and vectors, or rolled back.

**Tradeoff:** pgvector's HNSW index is less mature than purpose-built vector databases at extreme scale (100M+ vectors). The search layer is isolated to `KnowledgeRepository.searchChunks()` — migrating to a dedicated vector store is a single-method change if scale demands it.

---

### Hybrid BM25 + vector search with Reciprocal Rank Fusion

**Decision:** Both PostgreSQL `tsvector` keyword search and `pgvector` cosine similarity run in parallel, fused with RRF.

**Why:** Pure vector misses exact keyword matches (invoice numbers, names, dates, product codes). Pure BM25 misses semantic similarity. RRF is rank-only — it sidesteps the score-incompatibility problem that breaks naively weighted score fusion. BM25 uses PostgreSQL's built-in full-text search, adding zero infrastructure cost.

**Tradeoff:** Two DB queries per search instead of one. The overhead is 5–10ms — negligible against the 300–800ms LLM calls that follow.

---

### LLM reranking with a fast model

**Decision:** After RRF, `gpt-4o-mini` scores all `KNOWLEDGE_RERANK_CANDIDATES` (24) chunks in a single batched prompt and returns the top-K.

**Why:** Bi-encoder embeddings score query and document independently. An LLM jointly attends to both, catching paraphrasing and subtle relevance that cosine similarity misses. One API call regardless of candidate pool size keeps cost constant at O(1) per search.

**Tradeoff:** ~300–500ms added latency and one extra API call per search. Disable with `KNOWLEDGE_RERANK_ENABLED=false` when latency is the priority.

---

### Dynamic chunk limit, not hardcoded

**Decision:** `KNOWLEDGE_SEARCH_LIMIT` defaults to 8 and is fully configurable. Invoice workflows override it to `-1` (all chunks).

**Why:** A fixed count of 5 is too restrictive for multi-part questions and long documents. A fixed count of 20 triggers the LLM "lost-in-the-middle" effect (Liu et al., 2023), reducing synthesis quality. The default of 8 balances coverage and precision for general enterprise Q&A.

**Tradeoff:** Higher limits increase latency and cost proportionally. The reranker already reduces the candidate pool before chunks reach the synthesizer.

---

### LLM-based invoice extraction over regex

**Decision:** `gpt-4o-mini` extracts structured invoice fields from document text (any format), not regex patterns.

**Why:** Regex works for one specific document layout. Real-world invoices come in dozens of formats — expense tables, labeled PDFs, receipts, purchase orders, multi-currency reports. The LLM handles all formats without format-specific code. It is instructed to extract only values explicitly present in the text and to use the document's own grand total line as the authoritative figure.

**Tradeoff:** One extra API call per invoice workflow (~300ms). Falls back gracefully to a regex grand-total extractor if Azure is unavailable — the pipeline never hard-fails.

---

### KB-first planning with a mandatory retrieval safety net

**Decision:** The planner is instructed to always call `knowledge.retrieve` for factual questions. A code-level safety net in `AgentRunner` injects retrieval if the planner returns zero tool calls on a non-greeting message.

**Why:** Without explicit instruction, LLMs sometimes answer from training data instead of the knowledge base. For an enterprise assistant whose value is answering from uploaded documents, this is the wrong default. The code-level guard cannot be bypassed by prompt variations.

**Tradeoff:** Retrieval runs even on messages where the knowledge base has nothing relevant. The synthesizer then says "I searched your documents but found nothing relevant." This is a better failure mode than silently hallucinating from training data.

---

### Validator trusts chunks over its own judgment

**Decision:** When `knowledge.retrieve` returned real chunks, the answer passes through even if the validator marks it `partially_grounded` or `unsupported`. The hard block fires only when zero chunks were retrieved.

**Why:** The LLM validator incorrectly marks correct answers as unsupported when the synthesizer paraphrases chunk text rather than quoting it verbatim. RRF scores (0.001 range) are deliberately omitted from the validator input to prevent them from being misread as "0% relevant." Suppressing correct, chunk-backed answers creates a worse user experience than an occasional soft caveat.

**Tradeoff:** Occasionally a `partially_grounded` answer with minor over-generalisation passes through with only a soft note. Chunk citations are always visible and auditable.

---

### Short-lived JWT access + opaque refresh tokens

**Decision:** 15-minute access JWTs verified locally in each service via shared `JWT_ACCESS_SECRET`. Opaque refresh tokens stored as HMAC-SHA256 hashes in PostgreSQL, rotated on every use.

**Why:** No network hop to the Auth Service on every API request — services verify tokens locally. Refresh rotation limits the replay window for stolen tokens. Logout is immediate — the hash is deleted from PostgreSQL.

**Tradeoff:** All services share `JWT_ACCESS_SECRET`. Rotating it requires a coordinated restart of all services. For production hardening, migrate to asymmetric signing — distribute the public key to each service and keep the private key only in Auth.

---

### Publish-after-commit Kafka events

**Decision:** Domain events are published to Kafka after PostgreSQL writes succeed. Kafka failure does not affect user responses.

**Why:** Simplicity. The request path never depends on Kafka availability. PostgreSQL is always the source of truth.

**Tradeoff:** The write and publish are not atomic. If a service crashes between the Postgres write and the Kafka publish, the event is silently lost. For exactly-once guarantees, implement the transactional outbox pattern: write an event row in the same database transaction, then have a relay worker publish it to Kafka and mark it sent.

---

## 8. API Reference

All endpoints require `Authorization: Bearer <accessToken>` except auth registration and login.

### Auth Service (port 4001)

| Method | Path                      | Description                              |
| ------ | ------------------------- | ---------------------------------------- |
| POST   | `/auth/register`          | Register a new user and tenant           |
| POST   | `/auth/login`             | Login, returns access + refresh tokens   |
| POST   | `/auth/refresh`           | Rotate refresh token, return new pair    |
| POST   | `/auth/logout`            | Revoke refresh token                     |
| GET    | `/health`                 | Service health check                     |

### AI Gateway (port 4002)

| Method | Path              | Description                                          |
| ------ | ----------------- | ---------------------------------------------------- |
| POST   | `/chat`           | Synchronous chat (returns final answer)              |
| POST   | `/chat/stream`    | SSE chat stream (step events + final answer)         |
| GET    | `/chat/ws`        | WebSocket chat stream                                |
| GET    | `/conversations`  | List conversations for the current user              |
| GET    | `/health`         | Service health check                                 |

Chat request body:
```json
{
  "message": "What is the reimbursement policy?",
  "conversationId": "optional-uuid-to-continue-a-thread"
}
```

### Knowledge Service (port 4003)

| Method | Path                       | Description                              |
| ------ | -------------------------- | ---------------------------------------- |
| POST   | `/documents`               | Upload a PDF or TXT document (multipart) |
| GET    | `/documents`               | List documents for the current user      |
| DELETE | `/documents/:documentId`   | Delete a document                        |
| POST   | `/search`                  | Direct hybrid search (used by tools)     |
| GET    | `/health`                  | Service health check                     |

### Tool Execution Service (port 4004)

| Method | Path              | Description                                          |
| ------ | ----------------- | ---------------------------------------------------- |
| GET    | `/tools`          | List all tool definitions (for the planner)          |
| POST   | `/tools/execute`  | Execute a tool by name with arguments                |
| GET    | `/health`         | Service health check                                 |

---

## 9. Deployment

### Docker (local full stack)

```bash
# Infrastructure only
docker compose up -d postgres redis kafka

# All services
docker compose --profile app up -d

# Rebuild a specific service
docker compose --profile app up -d --build ai-gateway
```

### Container images

Images are built from `infra/docker/backend.Dockerfile` — a shared multi-stage Dockerfile that accepts `--build-arg SERVICE_PACKAGE=@knoviq/<name>`. The CI pipeline validates all four Dockerfiles on every pull request.

Published to GitHub Container Registry on version tags:

```
ghcr.io/<owner>/knoviq-auth-service:<tag>
ghcr.io/<owner>/knoviq-ai-gateway:<tag>
ghcr.io/<owner>/knoviq-knowledge-service:<tag>
ghcr.io/<owner>/knoviq-tool-execution-service:<tag>
```

### Kubernetes

Base manifests live in `infra/k8s/base/`. Apply with kustomize:

```bash
kubectl kustomize infra/k8s/base | kubectl apply -f -

# Or with environment overlays
kubectl kustomize infra/k8s/overlays/production | kubectl apply -f -
```

All services are stateless and horizontally scalable:

```bash
kubectl scale deployment ai-gateway --replicas=3
kubectl scale deployment auth-service --replicas=2
kubectl scale deployment tool-execution-service --replicas=3
```

`knowledge-service` uses a `ReadWriteOnce` volume for the upload directory. For multi-replica knowledge-service in production, replace local file storage with an S3-compatible object store.

### CI/CD

GitHub Actions runs on every pull request and push to `main`:

| Job         | What it does                                                                      |
| ----------- | --------------------------------------------------------------------------------- |
| `quality`   | pnpm install → format check → build → lint → typecheck → test                    |
| `docker`    | `docker buildx build --check` for all 4 backend service Dockerfiles              |
| `manifests` | `kubectl kustomize` renders base manifests and validates required resources exist |

Container images are published to GHCR automatically on `v*.*.*` version tags via `container-publish.yml`.
