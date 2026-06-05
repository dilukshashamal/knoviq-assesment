# Knoviq - Enterprise AI Knowledge Assistant

Knoviq is a production-ready, multi-tenant AI knowledge assistant. Users upload PDF and TXT documents into a private knowledge base, then chat with an AI that retrieves, cites, and synthesises answers strictly from those documents. Five independent microservices handle authentication, AI orchestration, document knowledge management, tool execution, and the web frontend — all living in one monorepo for developer convenience.

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
│                    Next.js 15  (port 3000)                       │
└────────────────┬──────────────────────────────┬─────────────────┘
                 │  /api/auth/*                  │  /api/chat
                 │  /api/documents               │
                 ▼                               ▼
   ┌─────────────────────┐          ┌────────────────────────┐
   │    Auth Service     │          │      AI Gateway        │
   │    port 4001        │          │      port 4002         │
   │                     │          │                        │
   │  Register / Login   │◄─JWT─────│  Planner Agent         │
   │  JWT issuance       │  verify  │  Tool Agents           │
   │  Refresh / Logout   │          │  Synthesizer Agent     │
   │  Tenant / RBAC      │          │  Validator Agent       │
   └─────────────────────┘          └──────────┬─────────────┘
                                               │  HTTP
                            ┌──────────────────┤
                            │                  │
               ┌────────────▼──────┐  ┌────────▼──────────────┐
               │ Knowledge Service │  │ Tool Execution Service│
               │ port 4003         │  │ port 4004             │
               │                   │◄─│                       │
               │ PDF/TXT ingest    │  │ knowledge.retrieve    │
               │ Hybrid chunking   │  │ calculator.evaluate   │
               │ Azure embeddings  │  │ sql.query_safe        │
               │ BM25 + vector     │  │ extract_invoice_fields│
               │ LLM reranking     │  │                       │
               └─────────┬─────────┘  └───────────────────────┘
                         │
             ┌───────────┴──────────┐
             ▼                      ▼
     ┌──────────────┐      ┌──────────────┐
     │  PostgreSQL  │      │    Redis     │
     │  + pgvector  │      │   (cache)    │
     └──────────────┘      └──────────────┘
             │
     ┌───────┴──────┐
     │    Kafka     │
     │   (events)   │
     └──────────────┘
```

### Monorepo Layout

```
apps/
  auth-service/            JWT auth, user/tenant management         (port 4001)
  ai-gateway/              Multi-agent chat orchestration           (port 4002)
  knowledge-service/       Document ingestion, hybrid RAG search    (port 4003)
  tool-execution-service/  Calculator, SQL, retrieval, invoices     (port 4004)
  web/                     Next.js 15 App Router frontend           (port 3000)

packages/
  @knoviq/ai               ToolName enum, shared AI types
  @knoviq/auth             JWT verification helpers
  @knoviq/cache            Redis client (TTL helpers, no-op fallback)
  @knoviq/config           Zod-validated environment loader
  @knoviq/contracts        Shared API schemas (health, errors, roles)
  @knoviq/database         pg Pool factory + withTransaction helper
  @knoviq/events           Kafka domain event publisher (disabled fallback)
  @knoviq/observability    OpenTelemetry spans, createTimer, LLM cost estimation

infra/
  docker/                  Shared multi-stage backend.Dockerfile
  k8s/                     Kubernetes base manifests + kustomize overlays
  migrations/              PostgreSQL schema migrations (002_types_and_tables.sql)

docs/
  architecture.md          Service diagram and data boundary reference
  decisions.md             Full ADR log for every architectural decision
```

Each backend service is its own Fastify process with its own `pg.Pool`, its own Docker image, and an independent deployment lifecycle. Shared packages are compiled libraries linked at build time — they introduce no runtime coupling between services.

### Data Ownership

No service reads from another service's database tables. All cross-service access goes through HTTP APIs.

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

# 4. Start infrastructure (PostgreSQL on port 55432, Redis, Kafka)
docker compose up -d postgres redis kafka

# 5. Build all packages and services
pnpm build

# 6. Start each backend service in a separate terminal
pnpm --filter @knoviq/auth-service start         # port 4001
pnpm --filter @knoviq/ai-gateway start           # port 4002
pnpm --filter @knoviq/knowledge-service start    # port 4003
pnpm --filter @knoviq/tool-execution-service start  # port 4004

# 7. Start the web frontend
pnpm --filter @knoviq/web dev                    # port 3000
```

Open `http://localhost:3000`.

### Development mode (hot reload)

```bash
# Replace `start` with `dev` for each service — uses `tsx watch`
pnpm --filter @knoviq/ai-gateway dev
```

`dev` mode picks up `.ts` file changes automatically. `start` mode runs from compiled `dist/`; after source changes you must run `pnpm build` and restart.

### Database migrations

Migrations apply automatically on first startup. To run them manually:

```bash
docker compose run --rm migrations
```

### Invoice smoke test

```bash
pnpm smoke:invoice
```

Builds the repo, starts all four backend services, uploads a sample invoice TXT, asks the agent to summarise it, and asserts the correct total — all in one command.

---

## 3. Environment Variables

Copy `.env.example` to `.env` and fill in the required values. All config is validated at startup via Zod; the service will refuse to start if required variables are missing or malformed.

### Azure OpenAI (required for production)

| Variable                                   | Description                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `AZURE_OPENAI_ENDPOINT`                    | Your Azure OpenAI resource endpoint URL                                                |
| `AZURE_OPENAI_API_KEY`                     | API key for the resource                                                               |
| `AZURE_OPENAI_API_VERSION`                 | API version, default `2025-04-01-preview`                                              |
| `AZURE_OPENAI_CHAT_DEPLOYMENT_FAST`        | Fast model (e.g. `gpt-4o-mini`) — planner, validator, reranker, invoice extraction     |
| `AZURE_OPENAI_CHAT_DEPLOYMENT_REASONING`   | Reasoning model (e.g. `gpt-4o`) — answer synthesis                                     |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`        | Embedding model (e.g. `text-embedding-3-small`)                                        |
| `AZURE_OPENAI_EMBEDDING_DIMENSIONS`        | Embedding dimensions, default `1536`                                                   |

Set `KNOWLEDGE_EMBEDDING_PROVIDER=local` and `AI_GATEWAY_MODEL_PROVIDER=local` to skip Azure entirely during local smoke testing. The local providers produce deterministic vectors and rule-based responses — useful for CI, not for real RAG quality.

### Auth

| Variable                 | Default  | Description                                    |
| ------------------------ | -------- | ---------------------------------------------- |
| `JWT_ACCESS_SECRET`      | —        | Min 32-char secret for signing access tokens   |
| `JWT_REFRESH_SECRET`     | —        | Min 32-char secret for signing refresh tokens  |
| `JWT_ACCESS_TTL_SECONDS` | `900`    | Access token lifetime (15 minutes)             |

### Knowledge Service tuning

| Variable                          | Default | Description                                             |
| --------------------------------- | ------- | ------------------------------------------------------- |
| `KNOWLEDGE_CHUNK_TARGET_CHARS`    | `1800`  | Target characters per chunk                             |
| `KNOWLEDGE_CHUNK_OVERLAP_CHARS`   | `250`   | Overlap between consecutive chunks                      |
| `KNOWLEDGE_SEARCH_LIMIT`          | `8`     | Final number of chunks returned to the agent            |
| `KNOWLEDGE_SEARCH_MIN_SIMILARITY` | `0.2`   | Minimum cosine similarity for vector retrieval          |
| `KNOWLEDGE_RERANK_ENABLED`        | `true`  | Enable LLM reranking after hybrid retrieval             |
| `KNOWLEDGE_RERANK_CANDIDATES`     | `24`    | Candidate pool fed into the reranker (should be 3–4×limit) |

### Infrastructure

| Variable        | Default                  | Description                            |
| --------------- | ------------------------ | -------------------------------------- |
| `DATABASE_URL`  | —                        | Full PostgreSQL connection string      |
| `DB_POOL_MAX`   | `10`                     | Max pg connections per service process |
| `REDIS_URL`     | `redis://localhost:6379` | Redis connection URL                   |
| `REDIS_ENABLED` | `true`                   | Set `false` to disable caching         |
| `KAFKA_ENABLED` | `true`                   | Set `false` to disable event publishing|
| `KAFKA_BROKERS` | `127.0.0.1:29092`        | Comma-separated Kafka broker addresses |

### LLM cost controls

| Variable                        | Default | Description                                        |
| ------------------------------- | ------- | -------------------------------------------------- |
| `LLM_DEFAULT_MAX_OUTPUT_TOKENS` | `1200`  | Hard cap on synthesis response length              |
| `LLM_MEMORY_MAX_MESSAGES`       | `12`    | Conversation history window (older messages drop)  |

---

## 4. RAG Pipeline

The retrieval-augmented generation pipeline spans the Knowledge Service and AI Gateway. It runs in two phases: ingestion (on upload) and retrieval (on every chat turn).

### 4.1 Document Ingestion

```
User uploads PDF or TXT
         │
         ▼
  ┌──────────────────────────────────────────────────────────┐
  │                    Knowledge Service                     │
  │                                                          │
  │  1. Deduplication — SHA-256 hash → reject duplicate      │
  │  2. Storage       — raw file saved to ./data/uploads/    │
  │  3. Text extract  — pdf-parse (PDF) / UTF-8 (TXT)        │
  │                                                          │
  │  4. Hybrid chunking (3-tier)                             │
  │     ├─ Tier 1: Structural splits                         │
  │     │   Markdown headings, ALL-CAPS title lines,         │
  │     │   horizontal rules, 2+ consecutive blank lines.    │
  │     │   Ensures headings always start their own chunk.   │
  │     │                                                    │
  │     ├─ Tier 2: Semantic sliding window                   │
  │     │   Sentence-boundary detection (`. `, `? `, `! `).  │
  │     │   Grows window to chunkTargetChars, then emits.    │
  │     │   Next window starts with chunkOverlapChars of     │
  │     │   context from the previous one.                   │
  │     │                                                    │
  │     └─ Tier 3: Keyword extraction                        │
  │         Top-10 highest-TF tokens (stop-words removed)    │
  │         stored in chunk metadata.keywords for BM25.      │
  │                                                          │
  │  5. Embedding — Azure text-embedding-3-small             │
  │     Content-hash cache dedup: identical chunks across    │
  │     documents never call the Azure API twice.            │
  │                                                          │
  │  6. Persist — document_chunks + embedding::vector(1536)  │
  │  7. Publish — knowledge.document.uploaded → Kafka        │
  └──────────────────────────────────────────────────────────┘
```

### 4.2 Hybrid Retrieval

When the agent calls `knowledge.retrieve`, the Knowledge Service runs two search arms in parallel and fuses them:

```
User query
    │
    ├── Embed query ──► pgvector cosine similarity (vector arm)
    │                   Filters by tenant, document access, minSimilarity.
    │                   Returns top-N with RRF rank by cosine distance.
    │
    └── BM25 search ──► PostgreSQL tsvector / plainto_tsquery (keyword arm)
                        Filters by same access rules. Falls back silently
                        if tsvector search errors (locale issues etc.).
                               │
                               ▼
                    Reciprocal Rank Fusion (RRF)
                    score = Σ 1 / (60 + rank_i)
                    Rank-only fusion avoids score-incompatibility between
                    cosine similarity and BM25 ts_rank_cd values.
                               │
                               ▼
                    LLM Reranking  (AZURE_OPENAI_CHAT_DEPLOYMENT_FAST)
                    All RRF candidates batched into a single prompt.
                    Each chunk scored 0–10 for relevance to the query.
                    Sorted by LLM score; RRF score is the tiebreak.
                    Falls back to RRF order on any LLM failure.
                    Disable: KNOWLEDGE_RERANK_ENABLED=false
                               │
                               ▼
                    Top-K chunks (default K=8) returned to agent
                    Cached in Redis for 60 s per (tenant, user, query, limit)
```

**Why hybrid?** Pure vector search misses exact keyword matches (invoice numbers, names, product codes, dates). Pure BM25 misses semantic similarity (paraphrasing, synonyms). RRF fusion consistently improves recall@10 over either arm alone.

**Why LLM reranking?** Bi-encoder embeddings score query and document independently; an LLM jointly attends to both, catching paraphrasing and subtle relevance that cosine similarity misses. One batched API call keeps cost at O(1) per search regardless of candidate pool size.

---

## 5. Tool Calling Flow

Every chat request enters `AgentRunner.run()` in the AI Gateway and passes through four sequential phases.

### 5.1 Agent Phases

```
POST /chat  { message, conversationId? }
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                     AgentRunner.run()                       │
  │                                                             │
  │  Phase 1 — PLANNER  (gpt-4o-mini, temp=0)                   │
  │  ─────────────────────────────────────────────────          │
  │  Input:  last 12 messages of conversation history           │
  │          tool definitions (fetched from Tool Execution      │
  │          Service, cached in Redis for 300s)                 │
  │          user message                                       │
  │  Output: JSON { toolCalls: [{ toolName, arguments,          │
  │                               reason }] }  (max 5)          │
  │                                                             │
  │  Safety net: if planner returns 0 tool calls and the        │
  │  message is not a pure greeting, code-level injection       │
  │  adds knowledge.retrieve unconditionally.                   │
  │                                                             │
  │  Phase 2 — TOOL AGENTS                                      │
  │  ──────────────────────────────────────────────             │
  │  For each planned tool call:                                │
  │    POST tool-execution-service/tools/execute                │
  │    ├─ knowledge.retrieve   → Knowledge Service /search      │
  │    ├─ calculator.evaluate  → in-process recursive parser    │
  │    ├─ sql.query_safe       → PostgreSQL read-only queries   │
  │    └─ extract_invoice_fields → Azure OpenAI gpt-4o-mini     │
  │                                                             │
  │  Follow-up chaining (up to 4 rounds):                       │
  │    invoice workflow auto-chains:                            │
  │    knowledge.retrieve → extract_invoice_fields → calculator │
  │                                                             │
  │  Phase 3 — SYNTHESIZER  (gpt-4o, temp=0.1)                  │
  │  ─────────────────────────────────────────────────          │
  │  Input:  structured chunk citations (RRF scores omitted     │
  │          to prevent LLM misreading 0.001 as "irrelevant")   │
  │          other tool outputs                                 │
  │  Output: grounded answer with source citations              │
  │                                                             │
  │  Phase 4 — VALIDATOR  (gpt-4o-mini, temp=0)                 │
  │  ─────────────────────────────────────────────────          │
  │  Scores answer: grounded | partially_grounded | unsupported │
  │  Guardrail logic:                                           │
  │    - chunks returned + grounded      → pass through         │
  │    - chunks returned + partial       → pass through         │
  │    - chunks returned + unsupported   → soft caveat appended │
  │    - no chunks at all + unsupported  → answer replaced      │
  │                                                             │
  │  Persist: conversation, messages, tool records, LLM usage   │
  │  Publish: agent.run.completed → Kafka                       │
  └─────────────────────────────────────────────────────────────┘
        │
        ▼
  { answer, toolCalls, validation, conversationId }
```

### 5.2 Available Tools

| Tool name                          | Where it runs                            | When the planner selects it                       |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `knowledge.retrieve`               | Knowledge Service `/search`              | All factual, informational, policy questions      |
| `calculator.evaluate`              | In-process recursive descent parser      | Numeric expressions; invoice total verification   |
| `sql.query_safe`                   | PostgreSQL (read-only, allowlisted ops)  | Usage metrics, document counts, cost reports      |
| `document.extract_invoice_fields`  | Azure OpenAI gpt-4o-mini                 | Invoice summarisation workflows                   |

### 5.3 Transport Options

All three transports emit identical structured step events: `conversation`, `agent_step`, `message`, `tool_start`, `tool_result`, `validation`, `final`.

| Endpoint            | Transport           | Use case                       |
| ------------------- | ------------------- | ------------------------------ |
| `POST /chat`        | HTTP (synchronous)  | Simple clients, testing        |
| `POST /chat/stream` | Server-Sent Events  | Web frontends                  |
| `GET /chat/ws`      | WebSocket           | Real-time bidirectional        |

### 5.4 KB-First Planning Rule

The planner is explicitly instructed to call `knowledge.retrieve` for any factual, informational, policy, procedure, or who/what/when/how/why question. The knowledge base is always the primary source of truth. A code-level safety net in `AgentRunner` injects a retrieval call after planning if the LLM planner returned zero tool calls and the message is not a greeting — this guard cannot be bypassed by prompt variations.

---

## 6. Scaling Considerations

### Stateless services

All four backend services hold no in-process session state. Conversation memory, tool logs, and LLM usage are persisted to PostgreSQL. Any service can be horizontally scaled behind a load balancer without sticky sessions.

### Database

- **pgvector HNSW index** on `document_chunks.embedding` gives approximate nearest-neighbour search at sub-millisecond latency up to millions of vectors. HNSW does not require periodic re-indexing, unlike IVFFlat.
- **Embedding cache** (`knoviq.embedding_cache`) deduplicates Azure API calls by content hash. Identical chunks across documents never re-embed.
- **Connection pooling** — `pg.Pool` with `DB_POOL_MAX` per service instance. Increase per replica in production.

### Caching

- **Tool definitions** cached in Redis for 5 minutes. At high request rates this eliminates repeated HTTP round-trips to the Tool Execution Service on every chat turn.
- **Search results** cached per `(tenantId, userId, query, limit, minSimilarity)` for 60 seconds. Repeated identical questions within a session skip the full retrieval + rerank pipeline.
- **Redis is optional.** If `REDIS_ENABLED=false`, all operations fall through to a no-op `DisabledCacheClient`. No code changes required.

### Kafka events

All domain events (`knowledge.document.uploaded`, `conversation.created`, `agent.run.completed`, `llm.usage.recorded`) are published to Kafka after the PostgreSQL write commits. Downstream consumers (analytics, audit, billing) can process events without coupling to the request path. If `KAFKA_ENABLED=false`, a `DisabledEventPublisher` silently drops all publishes — the user-facing response path is unaffected.

### LLM cost controls

| Mechanism          | Implementation                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| Token budget       | `LLM_DEFAULT_MAX_OUTPUT_TOKENS=1200` hard cap on synthesis output      |
| Memory window      | `LLM_MEMORY_MAX_MESSAGES=12` — older messages dropped from context     |
| Rerank pool size   | `KNOWLEDGE_RERANK_CANDIDATES=24` — controls LLM rerank input size      |
| Model routing      | Planning and validation use `gpt-4o-mini`; synthesis uses `gpt-4o`     |
| Per-model pricing  | `@knoviq/observability` maintains a built-in pricing table by deployment name substring, so `gpt-4o` synthesis is not undercharged at the `gpt-4o-mini` rate |
| Embedding cache    | Content-hash dedup prevents re-embedding identical chunks across docs  |

### Kubernetes

`infra/k8s/base/` contains Deployment and Service manifests for all services. Scaling any service is one command:

```bash
kubectl scale deployment ai-gateway --replicas=3
kubectl scale deployment knowledge-service --replicas=2
```

Default replicas in base: auth=2, ai-gateway=2, knowledge=1 (ReadWriteOnce volume for uploads), tools=2.

---

## 7. Architecture Decisions & Tradeoffs

### Microservices in a monorepo

Five independently deployed services, all source in one git repository with Turborepo and pnpm workspaces.

**Why microservices:** Each service has a distinct bounded context and independent scaling requirements. The AI Gateway can scale to handle chat load without touching Auth. The Knowledge Service can adopt a new embedding model without rebuilding anything else.

**Why monorepo:** Shared TypeScript packages (`@knoviq/contracts`, `@knoviq/ai`, `@knoviq/database`) stay in sync across all services. Atomic cross-service changes land in one pull request. Single CI pipeline. No version drift between packages.

**Tradeoff:** Build times grow with the codebase. Mitigated by Turborepo — only changed packages rebuild. Any service can be extracted to its own repository; the HTTP interfaces between services would not change.

---

### PostgreSQL + pgvector instead of a dedicated vector database

Embeddings stored in `document_chunks.embedding::vector` using the pgvector extension, not a separate service like Pinecone or Qdrant.

**Why:** No additional infrastructure. Full SQL joins between vector search and relational data — tenant isolation, visibility filters, and document status checks happen in a single query. Transactional consistency: a document is either fully ingested with all chunks and vectors, or rolled back.

**Tradeoff:** pgvector's HNSW index is less mature than purpose-built vector databases at extreme scale (100M+ vectors). The search layer is isolated to `KnowledgeRepository.searchChunks()` — migrating to a dedicated vector store is a single-class change if scale eventually demands it.

---

### Hybrid BM25 + vector search with Reciprocal Rank Fusion

Both PostgreSQL `tsvector` keyword search and `pgvector` cosine similarity run in parallel, fused with RRF.

**Why:** Pure vector search misses exact keyword matches (invoice numbers, names, dates, product codes). Pure BM25 misses semantic similarity. RRF is rank-only — it avoids the score-incompatibility problem that breaks naively-weighted score fusion. BM25 is free: it uses PostgreSQL's built-in full-text search with no additional infrastructure.

**Tradeoff:** Two database queries per search instead of one. In practice the overhead is 5–10ms — negligible compared to the 300–800ms LLM calls that follow.

---

### LLM reranking with a fast model

After RRF retrieval, `gpt-4o-mini` scores each candidate chunk 0–10 for relevance in a single batched prompt, then the top-K are returned.

**Why:** Bi-encoder embeddings encode query and document independently. An LLM jointly attends to both, catching paraphrasing and subtle relevance that cosine similarity misses. Batching all candidates into one prompt keeps the cost at O(1) API calls per search regardless of pool size.

**Tradeoff:** Adds ~300–500ms latency and one extra API call per search. Disable with `KNOWLEDGE_RERANK_ENABLED=false` when latency is the priority.

---

### LLM-based invoice extraction over regex

`gpt-4o-mini` extracts structured invoice fields (number, vendor, date, amount, currency) from any document format — expense tables, labeled PDFs, receipts, purchase orders, multi-currency reports.

**Why:** Regex works only for one specific document layout. Real-world invoices come in dozens of formats. An LLM handles all formats without format-specific code. The LLM is instructed to extract only values explicitly present in the text and to use the document's own verified grand-total line as the authoritative figure.

**Tradeoff:** Adds one LLM call per invoice extraction (~300ms). Falls back gracefully to a regex grand-total extractor if Azure is unavailable — the pipeline never hard-fails.

---

### Validator guardrail that trusts chunks over its own judgment

When `knowledge.retrieve` returned real chunks, the answer passes through even if the LLM validator marks it `partially_grounded` or `unsupported`. The hard block fires only when zero chunks were retrieved.

**Why:** The LLM validator can incorrectly mark a correct answer as unsupported when the synthesiser's phrasing is a paraphrase of the chunk text rather than verbatim. Completely suppressing correct, chunk-backed answers creates a worse user experience than a soft caveat. Raw RRF scores (0.001 range) are deliberately omitted from the validator input to prevent them from being misread as "0% relevant".

**Tradeoff:** Occasionally a `partially_grounded` answer with minor over-generalisation passes through with only a soft note. Chunk citations are always visible and auditable.

---

### JWT access + opaque refresh tokens

Short-lived JWTs (15 min) verified locally in each service via shared `JWT_ACCESS_SECRET`. Opaque refresh tokens stored as HMAC-SHA256 hashes in PostgreSQL with rotation on every use.

**Why:** No network hop to Auth on every request — services verify tokens locally. Refresh rotation limits the replay window for stolen tokens. Logout is immediate — the hash is deleted from PostgreSQL.

**Tradeoff:** All services share `JWT_ACCESS_SECRET`. Rotating it requires a coordinated restart of all services. For production hardening, replace with asymmetric signing: distribute the public key to each service and keep the private key only in the Auth Service.

---

### Publish-after-commit Kafka events

Domain events are published to Kafka after PostgreSQL writes succeed. Kafka failure does not affect user requests.

**Why:** Simplicity. The request path never depends on Kafka availability. PostgreSQL is always the source of truth.

**Tradeoff:** The write and publish are not atomic. If a service writes to PostgreSQL and crashes before the Kafka publish, the event is silently lost. For exactly-once guarantees, implement a transactional outbox: write an event row in the same database transaction, then have a relay worker publish it to Kafka.

---

## 8. API Reference

### Auth Service (port 4001)

| Method | Path              | Description                          |
| ------ | ----------------- | ------------------------------------ |
| `POST` | `/auth/register`  | Create user + tenant, returns tokens |
| `POST` | `/auth/login`     | Login, returns tokens                |
| `POST` | `/auth/refresh`   | Refresh access token                 |
| `POST` | `/auth/logout`    | Revoke refresh token                 |
| `GET`  | `/health`         | Health check                         |

### AI Gateway (port 4002)

| Method | Path            | Description                      |
| ------ | --------------- | -------------------------------- |
| `POST` | `/chat`         | Synchronous chat (full response) |
| `POST` | `/chat/stream`  | SSE streaming chat               |
| `GET`  | `/chat/ws`      | WebSocket chat                   |
| `GET`  | `/health`       | Health check                     |

### Knowledge Service (port 4003)

| Method   | Path              | Description                               |
| -------- | ----------------- | ----------------------------------------- |
| `POST`   | `/documents`      | Upload PDF or TXT (`multipart/form-data`) |
| `GET`    | `/documents`      | List documents for the current tenant     |
| `DELETE` | `/documents/:id`  | Delete document + all chunks              |
| `POST`   | `/search`         | Hybrid BM25 + vector search               |
| `GET`    | `/health`         | Health check                              |

### Tool Execution Service (port 4004)

| Method | Path              | Description                                |
| ------ | ----------------- | ------------------------------------------ |
| `GET`  | `/tools`          | Get tool definitions (for AI Gateway)      |
| `POST` | `/tools/execute`  | Execute a named tool with arguments        |
| `GET`  | `/health`         | Health check                               |

---

## 9. Deployment

### Docker

A single parameterised `Dockerfile` builds all four backend services. The `SERVICE_PACKAGE` build argument selects which workspace package to compile.

```bash
# Build all backend images
pnpm docker:build:backend

# Or individually
pnpm docker:build:auth
pnpm docker:build:ai
pnpm docker:build:knowledge
pnpm docker:build:tools

# Run the full stack
docker compose up -d
```

Images are published to GitHub Container Registry on every version tag (`v*.*.*`) via `.github/workflows/container-publish.yml`.

### Kubernetes

```bash
# Apply base manifests
kubectl apply -k infra/k8s/base

# Scale individual services
kubectl scale deployment ai-gateway --replicas=3
kubectl scale deployment knowledge-service --replicas=2
```

### CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`:

- `quality` — format check, build, lint, typecheck, test
- `docker` — `docker buildx build --check` for each service Dockerfile
- `manifests` — `kubectl kustomize` + validation that all four services are present

### Production secrets

Inject secrets via Kubernetes `Secret` resources or a secrets manager (AWS Secrets Manager, Azure Key Vault). Never commit `.env` files with real credentials.

Required secrets:

- `AZURE_OPENAI_API_KEY`
- `JWT_ACCESS_SECRET` (min 32 chars)
- `JWT_REFRESH_SECRET` (min 32 chars)
- `DATABASE_URL`
