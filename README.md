<<<<<<< HEAD

# Knoviq — Enterprise AI Knowledge Assistant Platform

Knoviq is a production-ready, multi-tenant AI knowledge assistant built as a **microservices** platform. Five independent services handle authentication, AI orchestration, document knowledge management, tool execution, and the web frontend. Each runs as its own process, has its own Docker image, and scales independently.

The codebase is organised as a **monorepo** — all services share one git repository — purely for developer convenience. The monorepo is a storage decision, not an architectural one. Microservices and monorepo are independent concepts; this project uses both together (the same pattern used by Google, Uber, and Meta).

Knoviq is a **microservices** platform — five independent services, each with its own process, port, Docker image, and independent deployment lifecycle. They communicate over HTTP and share no in-process state.

The source code is organised as a **monorepo** (all services in one git repository) purely for developer convenience: atomic cross-service changes, shared TypeScript packages, and a single CI pipeline. The monorepo is a code organisation choice, not an architectural one. Each service can still be built, containerised, and scaled independently.

```
┌────────────────────────────────────── Monorepo boundary (code only) ──────────┐
│                                                                                │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │Auth Service  │   │ AI Gateway   │   │  Knowledge   │   │    Tool      │  │
│  │ port 4001    │   │  port 4002   │   │   Service    │   │  Execution   │  │
│  │              │   │              │   │  port 4003   │   │  port 4004   │  │
│  │Own process   │   │Own process   │   │Own process   │   │Own process   │  │
│  │Own DB pool   │   │Own DB pool   │   │Own DB pool   │   │Own DB pool   │  │
│  │Own Docker    │   │Own Docker    │   │Own Docker    │   │Own Docker    │  │
│  │  image       │   │  image       │   │  image       │   │  image       │  │
│  └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘  │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  Shared packages  (@knoviq/cache, @knoviq/database, @knoviq/events …)  │  │
│  │  Compiled and linked at build time — zero runtime coupling              │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

Each microservice satisfies the key microservice properties:

| Property                     | How Knoviq implements it                                                    |
| ---------------------------- | --------------------------------------------------------------------------- |
| **Independent deployment**   | Each service has its own `Dockerfile` and `npm run start` script            |
| **Independent scaling**      | `kubectl scale deployment ai-gateway --replicas=3` scales only that service |
| **Own data ownership**       | Each service has its own schema tables and connection pool                  |
| **Communicate over network** | Services talk via HTTP (REST); never import each other's source code        |
| **Failure isolation**        | If Tool Execution Service is down, Auth and Knowledge Service keep running  |
| **Technology independence**  | Each service can adopt a different runtime, language, or DB in future       |

The shared packages (`@knoviq/cache`, `@knoviq/database`, etc.) are compiled libraries — like npm packages. They introduce zero runtime coupling: a shared package is a build-time dependency, not a shared process or shared memory.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Setup Instructions](#3-setup-instructions)
4. [Environment Variables](#4-environment-variables)
5. [RAG Pipeline](#5-rag-pipeline)
6. [Tool Calling Flow](#6-tool-calling-flow)
7. [Multi-Agent Orchestration](#7-multi-agent-orchestration)
8. [Invoice Extraction Workflow](#8-invoice-extraction-workflow)
9. [Scaling Considerations](#9-scaling-considerations)
10. [Architecture Decisions and Tradeoffs](#10-architecture-decisions-and-tradeoffs)
11. [API Reference](#11-api-reference)
12. [Deployment](#12-deployment)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser / Client                         │
│                       Next.js 15  (port 3000)                    │
└──────────┬──────────────────────────────────────────┬───────────┘
           │  /api/auth/*  /api/chat  /api/documents  │
           ▼                                          ▼
┌──────────────────┐                      ┌──────────────────────┐
│  Auth Service    │                      │    AI Gateway        │
│  (port 4001)     │                      │    (port 4002)       │
│                  │                      │                      │
│ • Register/login │◄─── JWT verify ──────│ • Planner agent      │
│ • JWT issue      │                      │ • Tool execution     │
│ • Refresh/logout │                      │ • Synthesizer agent  │
│ • Tenant/RBAC    │                      │ • Validator agent    │
└──────────────────┘                      └──────────┬───────────┘
                                                     │
                          ┌──────────────────────────┤
                          │                          │
                          ▼                          ▼
             ┌────────────────────┐    ┌─────────────────────────┐
             │  Knowledge Service │    │  Tool Execution Service  │
             │  (port 4003)       │    │  (port 4004)             │
             │                    │    │                          │
             │ • PDF/TXT ingest   │◄───│ • knowledge.retrieve     │
             │ • Hybrid chunking  │    │ • calculator.evaluate    │
             │ • Azure embeddings │    │ • sql.query_safe         │
             │ • BM25 + vector    │    │ • extract_invoice_fields │
             │ • LLM reranking    │    │   (LLM-based, any format)│
             └────────┬───────────┘    └─────────────────────────┘
                      │
          ┌───────────┴──────────┐
          ▼                      ▼
  ┌──────────────┐      ┌──────────────┐
  │  PostgreSQL  │      │    Redis     │
  │  + pgvector  │      │  (cache)     │
  └──────────────┘      └──────────────┘
          │
  ┌───────┴──────┐
  │    Kafka     │
  │  (events)    │
  └──────────────┘
```

### Monorepo Structure

```
apps/
  auth-service/           JWT auth, user/tenant management
  ai-gateway/             Multi-agent chat orchestration
  knowledge-service/      Document ingestion, hybrid RAG search
  tool-execution-service/ Calculator, SQL, knowledge retrieval, invoice extraction
  web/                    Next.js 15 frontend (App Router)

packages/
  @knoviq/ai              ToolName enum, shared AI types
  @knoviq/auth            JWT verification helpers
  @knoviq/cache           Redis client wrapper (TTL, key prefix, no-op fallback)
  @knoviq/config          Zod-validated environment loader
  @knoviq/contracts       Shared API schemas (health, errors, roles)
  @knoviq/database        pg Pool factory + withTransaction helper
  @knoviq/events          Kafka domain event publisher (DisabledEventPublisher fallback)
  @knoviq/observability   OpenTelemetry spans, createTimer, LLM cost estimation

infra/
  docker/                 Shared backend Dockerfile
  k8s/                    Kubernetes base manifests + kustomize overlays
  migrations/             PostgreSQL schema migrations

docs/                     Architecture documentation
```

---

## 2. Prerequisites

| Requirement             | Version                                   |
| ----------------------- | ----------------------------------------- |
| Node.js                 | `≥ 20.9` (`22.x` recommended)             |
| pnpm (via Corepack)     | `10.13.1`                                 |
| Docker Desktop / Engine | `≥ 24`                                    |
| Azure OpenAI resource   | Required for production embeddings + chat |

---

## 3. Setup Instructions

### 3.1 First-time local setup

```bash
# 1. Enable pnpm via Corepack
corepack enable
corepack prepare pnpm@10.13.1 --activate

# 2. Install all workspace dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env — fill in AZURE_OPENAI_* values and JWT secrets

# 4. Start infrastructure (PostgreSQL, Redis, Kafka)
docker compose up -d postgres redis kafka

# 5. Build all packages and services
pnpm build

# 6. Start all backend services (each in a separate terminal)
pnpm --filter @knoviq/auth-service start       # port 4001
pnpm --filter @knoviq/ai-gateway start         # port 4002
pnpm --filter @knoviq/knowledge-service start  # port 4003
pnpm --filter @knoviq/tool-execution-service start  # port 4004

# 7. Start the web frontend
pnpm --filter @knoviq/web dev                  # port 3000
```

Open `http://localhost:3000` in your browser.

### 3.2 Database setup

PostgreSQL runs on `127.0.0.1:55432` (non-default port to avoid conflicts with local Postgres).

Migrations are applied automatically on first startup. To run manually:

```bash
docker compose run --rm migrations
```

### 3.3 Development mode (auto-reload)

```bash
# In separate terminals:
pnpm --filter @knoviq/auth-service dev
pnpm --filter @knoviq/ai-gateway dev
pnpm --filter @knoviq/knowledge-service dev
pnpm --filter @knoviq/tool-execution-service dev
pnpm --filter @knoviq/web dev
```

`dev` mode uses `tsx watch` which reloads on every `.ts` file save. Changes to `.ts` source files are picked up automatically — no rebuild needed.

> **Important:** `start` mode runs from compiled `dist/` files. After code changes in `start` mode, run `pnpm build` and restart the service.

### 3.4 Run the invoice smoke test

```bash
pnpm smoke:invoice
```

This builds the repo, starts all four backend services, uploads a sample invoice TXT, asks the agent to summarize it, and asserts the correct total — all in one command.

---

## 4. Environment Variables

Copy `.env.example` to `.env` and fill in the required values.

### Azure OpenAI (required for production)

| Variable                                 | Description                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AZURE_OPENAI_ENDPOINT`                  | Your Azure OpenAI resource endpoint URL                                                                            |
| `AZURE_OPENAI_API_KEY`                   | API key for the resource                                                                                           |
| `AZURE_OPENAI_API_VERSION`               | API version, default `2025-04-01-preview`                                                                          |
| `AZURE_OPENAI_CHAT_DEPLOYMENT_FAST`      | Fast model deployment name (e.g. `gpt-4o-mini`) — used for planning, validation, reranking, and invoice extraction |
| `AZURE_OPENAI_CHAT_DEPLOYMENT_REASONING` | Reasoning model deployment name (e.g. `gpt-4o`) — used for answer synthesis                                        |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`      | Embedding model name (e.g. `text-embedding-3-small`)                                                               |
| `AZURE_OPENAI_EMBEDDING_DIMENSIONS`      | Embedding dimensions, default `1536`                                                                               |

### Auth

| Variable                 | Description                                   |
| ------------------------ | --------------------------------------------- |
| `JWT_ACCESS_SECRET`      | Min 32-char secret for signing access tokens  |
| `JWT_REFRESH_SECRET`     | Min 32-char secret for signing refresh tokens |
| `JWT_ACCESS_TTL_SECONDS` | Access token lifetime, default `900` (15 min) |

### Knowledge Service

| Variable                          | Default | Description                                    |
| --------------------------------- | ------- | ---------------------------------------------- |
| `KNOWLEDGE_EMBEDDING_PROVIDER`    | `azure` | `azure` or `local` (deterministic dev vectors) |
| `KNOWLEDGE_CHUNK_TARGET_CHARS`    | `1800`  | Target characters per chunk                    |
| `KNOWLEDGE_CHUNK_OVERLAP_CHARS`   | `250`   | Overlap between consecutive chunks             |
| `KNOWLEDGE_SEARCH_MIN_SIMILARITY` | `0.2`   | Minimum cosine similarity for vector retrieval |
| `KNOWLEDGE_RERANK_ENABLED`        | `true`  | Enable LLM reranking after hybrid search       |
| `KNOWLEDGE_RERANK_CANDIDATES`     | `20`    | Candidate pool size fed into the reranker      |
| `KNOWLEDGE_SEARCH_LIMIT`          | `5`     | Final number of chunks returned to the agent   |

### Infrastructure

| Variable        | Default                  | Description                            |
| --------------- | ------------------------ | -------------------------------------- |
| `DATABASE_URL`  | —                        | Full PostgreSQL connection string      |
| `REDIS_URL`     | `redis://localhost:6379` | Redis connection URL                   |
| `REDIS_ENABLED` | `true`                   | Disable to skip caching entirely       |
| `KAFKA_ENABLED` | `true`                   | Disable to skip event publishing       |
| `KAFKA_BROKERS` | `127.0.0.1:29092`        | Comma-separated Kafka broker addresses |

---

## 5. RAG Pipeline

The retrieval-augmented generation pipeline runs across three services on every chat turn where documents may be relevant.

### 5.1 Document Ingestion

```
User uploads PDF/TXT
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │                    Knowledge Service                     │
  │                                                          │
  │  1. Deduplication   SHA-256 hash → reject duplicate      │
  │  2. Storage         Save raw file to ./data/uploads/     │
  │  3. Text extraction pdf-parse (PDF) / UTF-8 (TXT)        │
  │  4. Hybrid chunking  ──────────────────────────────────  │
  │     ├─ Tier 1: Structural splits                         │
  │     │   Markdown headings, ALL-CAPS titles,              │
  │     │   horizontal rules, 2+ blank lines                 │
  │     ├─ Tier 2: Semantic sliding window                   │
  │     │   Sentence-boundary detection with configurable    │
  │     │   overlap (default 250 chars)                      │
  │     └─ Tier 3: Keyword extraction                        │
  │         Top-10 TF tokens → stored in chunk metadata     │
  │         for BM25 retrieval                               │
  │  5. Embedding        Azure text-embedding-3-small        │
  │     (deduplicated via content-hash cache)                │
  │  6. Persist         document_chunks + embedding::vector  │
  │  7. Publish         knowledge.document.uploaded → Kafka  │
  └─────────────────────────────────────────────────────────┘
```

### 5.2 Hybrid Retrieval

When the agent calls `knowledge.retrieve`, the Knowledge Service runs two search arms in parallel and fuses them:

```
User query
    │
    ├─── Embed query ──► pgvector cosine similarity search
    │                    (retrieves top-N by embedding distance)
    │
    └─── BM25 search ──► PostgreSQL tsvector full-text search
                         plainto_tsquery('english', query)
                         (retrieves top-N by keyword rank)
                              │
                              ▼
                    Reciprocal Rank Fusion (RRF)
                    score = Σ 1/(60 + rank_i)
                    (rank-only, score-incompatibility safe)
                              │
                              ▼
                    LLM Reranking (AZURE_OPENAI_CHAT_DEPLOYMENT_FAST)
                    Batch-scores all RRF candidates 0–10 for
                    relevance to the original query.
                    One API call regardless of candidate count.
                    Falls back to RRF order on failure.
                              │
                              ▼
                    Top-K chunks returned to agent
                    (default K = 5)
```

**Why hybrid search?** Pure vector search misses exact keyword matches (names, codes, dates). Pure BM25 misses semantic similarity. RRF fusion improves recall from ~65% to ~91% recall@10 over either alone (Cormack et al., SIGIR 2009).

**Why LLM reranking?** Bi-encoder embeddings encode query and document independently. An LLM jointly attends to both, detecting paraphrasing and subtle relevance that cosine similarity misses. One batched call keeps cost at O(1) per search regardless of candidate count.

### 5.3 Chunking Strategy

The three-tier hybrid chunker avoids the two failure modes of naive fixed-size chunking:

- **Structural splits** ensure headings always start their own chunk — a heading like "INVOICE SUMMARY" is never split mid-thought, preserving its semantic anchor in the embedding.
- **Semantic sliding window** respects sentence boundaries so answers that span a sentence boundary are never lost.
- **Keyword extraction** populates the `metadata.keywords` column used by the BM25 arm, bridging the vocabulary gap between chunk content and the tsvector index.

---

## 6. Tool Calling Flow

The AI Gateway exposes a tool-calling interface to any registered tool in the Tool Execution Service.

### 6.1 Available Tools

| Tool name                         | What it does                                                           | When it runs                            |
| --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| `knowledge.retrieve`              | Hybrid BM25 + vector search with LLM reranking                         | Every factual/informational question    |
| `calculator.evaluate`             | Safe arithmetic evaluator (custom recursive descent parser, no `eval`) | Numeric expressions or invoice totals   |
| `sql.query_safe`                  | Read-only parameterised SQL reports (allowlisted operations only)      | Usage metrics, document counts, latency |
| `document.extract_invoice_fields` | LLM-based invoice extraction — any document format                     | Invoice summarization workflows         |

### 6.2 End-to-End Tool Call Flow

```
POST /chat { message }
        │
        ▼
   AI Gateway
        │
   1. Load conversation memory (last 12 messages)
        │
   2. Fetch tool definitions from Tool Execution Service
      (cached in Redis for 300 s)
        │
   3. PLANNER (gpt-4o-mini, temp=0)
      Returns JSON: { toolCalls: [{ toolName, arguments, reason }] }
      Safety net: always injects knowledge.retrieve for non-greetings
        │
   4. For each planned tool call:
        │
        ├──► Tool Execution Service POST /tools/execute
        │         │
        │         ├─ knowledge.retrieve ──► Knowledge Service /search
        │         ├─ calculator.evaluate ──► In-process parser
        │         ├─ sql.query_safe ──► PostgreSQL (read-only)
        │         └─ extract_invoice_fields ──► Azure OpenAI LLM
        │
        ▼
   5. Follow-up chaining (up to 4 rounds)
      Invoice workflow: retrieve → extract → calculate
        │
   6. SYNTHESIZER (gpt-4o, temp=0.1)
      Receives structured chunk citations, produces grounded answer
        │
   7. VALIDATOR (gpt-4o-mini, temp=0)
      Checks: is every claim grounded in retrieved chunks?
      If knowledge was retrieved and chunks exist → answer passes through
      If no chunks → guardrail replaces answer with clear "not found" message
        │
   8. Persist: conversation, messages, tool records, LLM usage
        │
   9. Publish: agent.run.completed → Kafka
        │
        ▼
   Response { answer, toolCalls, validation, conversationId }
```

### 6.3 KB-First Planning Rule

The planner is instructed to **always** call `knowledge.retrieve` for any factual, informational, policy, procedure, or who/what/when/how/why question — even if it seems general. The knowledge base is the primary source of truth. Only pure greetings (`hi`, `thanks`) and standalone arithmetic skip retrieval.

A mandatory safety net in `AgentRunner` injects a `knowledge.retrieve` call after planning if the LLM planner returned zero tool calls and the message is not a greeting. This prevents silent failures where the LLM decides to answer from training data instead of documents.

### 6.4 Validation Guardrail

The validator receives:

- The synthesized draft answer
- The actual retrieved chunk snippets (up to 600 chars each)
- A `requiresGroundedEvidence` flag (true whenever knowledge retrieval was attempted)

It checks whether every factual claim in the answer appears in the retrieved chunks. When chunks were retrieved and the answer is based on them, the guardrail allows the answer through even if the validator rates it `partially_grounded`. Only when zero chunks were retrieved and the LLM appears to be answering from training data does the guardrail replace the answer entirely.

---

## 7. Multi-Agent Orchestration

Each chat turn runs four sequential agent phases:

```
┌──────────────────────────────────────────────────────────────┐
│                      AgentRunner.run()                        │
│                                                              │
│  ┌─────────────────┐                                         │
│  │   Conversation  │  Create/resume conversation             │
│  │   Manager       │  Store user message                     │
│  └────────┬────────┘                                         │
│           │                                                  │
│  ┌────────▼────────┐                                         │
│  │    Planner      │  gpt-4o-mini, temp=0                    │
│  │    Agent        │  JSON tool plan → max 5 tool calls       │
│  └────────┬────────┘                                         │
│           │  (for each tool call)                            │
│  ┌────────▼────────┐                                         │
│  │   Tool Agents   │  Isolated per-tool execution            │
│  │   (parallel     │  → Tool Execution Service               │
│  │    available)   │  Up to 4 follow-up chaining rounds      │
│  └────────┬────────┘                                         │
│           │                                                  │
│  ┌────────▼────────┐                                         │
│  │  Synthesizer    │  gpt-4o, temp=0.1                       │
│  │  Agent          │  Grounded answer from chunk citations    │
│  └────────┬────────┘                                         │
│           │                                                  │
│  ┌────────▼────────┐                                         │
│  │  Validator      │  gpt-4o-mini, temp=0                    │
│  │  Agent          │  Hallucination risk check               │
│  │                 │  grounded / partially_grounded /        │
│  │                 │  unsupported                            │
│  └────────┬────────┘                                         │
│           │                                                  │
│    Final answer + validation metadata                        │
└──────────────────────────────────────────────────────────────┘
```

### Streaming

The AI Gateway exposes three transport options:

| Endpoint            | Transport          | Use case                |
| ------------------- | ------------------ | ----------------------- |
| `POST /chat`        | HTTP (sync)        | Simple clients, testing |
| `POST /chat/stream` | Server-Sent Events | Web frontends           |
| `GET /chat/ws`      | WebSocket          | Real-time bidirectional |

All three emit the same structured step events: `conversation`, `agent_step`, `message`, `tool_start`, `tool_result`, `validation`, `final`.

---

## 8. Invoice Extraction Workflow

The invoice pipeline is a three-step agent chain that runs automatically when the user asks about invoice totals or expenses.

```
User: "Summarize invoices for April 2026"
        │
        ▼
  knowledge.retrieve
  (minSimilarity: -1, returns all chunks)
        │
        ▼
  document.extract_invoice_fields
  ├─ LLM (gpt-4o-mini) reads all chunk text
  ├─ Extracts: invoiceNumber, vendor, date, description, amount
  ├─ Filters by requested period
  ├─ Finds document's own grand total line (most authoritative)
  └─ Returns: invoices[], totalAmount, period, expression
        │
        ▼
  calculator.evaluate
  ├─ Input: totalAmount from extraction (not sum of possibly
  │  misextracted per-invoice amounts)
  └─ Output: verified total
        │
        ▼
  Synthesizer produces grounded answer with citations
```

### Why LLM for extraction, not regex

Regex works only for one specific document layout. Real-world invoices come in dozens of formats — expense tables, PDFs with labelled fields, scanned documents, multi-currency reports, receipts, purchase orders. An LLM can understand all formats without format-specific code. The LLM extraction is instructed to:

- Return only values explicitly present in the text (no hallucination)
- Identify the grand total from the document's own verified summary section
- Filter by the requested period before returning results
- Use a single batch call (not one call per invoice) to keep cost O(1)

---

## 9. Scaling Considerations

### Stateless services

All four backend services are stateless — no in-process session state. Conversation memory, tool execution logs, and LLM usage are all stored in PostgreSQL. This means any service can be horizontally scaled by running multiple replicas behind a load balancer without sticky sessions.

### Database

- **pgvector HNSW index** on `document_chunks.embedding` supports approximate nearest-neighbour search at sub-millisecond latency up to millions of vectors. HNSW scales better than IVFFlat for write-heavy workloads (no periodic re-indexing required).
- **Embedding cache** in `knoviq.embedding_cache` deduplicates embedding API calls by content hash. Identical chunks across documents never hit the Azure API twice.
- **Connection pooling** via `pg.Pool` with configurable `DB_POOL_MAX`. Set to 10 per service in development; increase per replica in production.

### Caching

- **Tool definitions** are cached in Redis for 5 minutes (configurable). At high request rates this eliminates repeated HTTP round-trips to the Tool Execution Service on every chat turn.
- **Search results** are cached per `(tenantId, userId, query, limit, minSimilarity)` hash for 60 seconds. Identical questions within the same session skip the full retrieval pipeline.
- **Redis is optional** — if disabled, all operations fall through to a no-op `DisabledCacheClient` with zero code changes.

### Kafka events

All domain events (document uploaded, conversation created, agent run completed, LLM usage, tool execution) are published to Kafka after commit. Downstream consumers (analytics, audit, billing) can process events independently without coupling to the request path. Kafka is optional — if `KAFKA_ENABLED=false`, a `DisabledEventPublisher` silently drops all publishes.

### LLM cost controls

| Mechanism         | Implementation                                                     |
| ----------------- | ------------------------------------------------------------------ |
| Token budget      | `LLM_DEFAULT_MAX_OUTPUT_TOKENS=1200` hard cap on synthesis         |
| Memory window     | `LLM_MEMORY_MAX_MESSAGES=12` — older messages dropped              |
| Rerank candidates | `KNOWLEDGE_RERANK_CANDIDATES=20` — controls LLM rerank input size  |
| Model routing     | Planning and validation use `gpt-4o-mini`; synthesis uses `gpt-4o` |
| Embedding cache   | Content-hash dedup prevents re-embedding identical chunks          |

### Kubernetes

`infra/k8s/` contains base manifests for all services. Each service has a separate `Deployment` and `Service` resource. Scaling any service is a single command:

```bash
kubectl scale deployment ai-gateway --replicas=3
```

---

## 10. Architecture Decisions and Tradeoffs

### Monorepo as code organisation (not architecture)

**Decision:** All microservices and shared packages live in one git repository with shared TypeScript tooling (Turborepo, pnpm workspaces).

**What this is NOT:** A monolith. The services remain independently deployed processes. Monorepo is purely about where the source code is stored.

**Benefits:** Atomic cross-service changes land in one pull request. Shared type definitions (`@knoviq/contracts`, `@knoviq/ai`) are always in sync. Single CI pipeline. Consistent dependency versions across all services.

**Tradeoff:** Build times grow with the repo. Mitigated with Turborepo caching — only changed packages rebuild. A team wanting full deployment independence can extract any service into its own repository at any time; the HTTP interfaces between services would not change.

---

### PostgreSQL + pgvector over a dedicated vector database

**Decision:** Store embeddings in `document_chunks.embedding::vector` using the pgvector extension instead of a separate service like Pinecone or Qdrant.

**Benefits:** No additional infrastructure to operate. Full SQL joins between vector search and relational data (tenant isolation, visibility filters, document status). Transactional consistency — a document is either fully ingested with all chunks and vectors, or rolled back.

**Tradeoff:** pgvector's HNSW index is less mature than purpose-built vector databases and may need tuning (`ef_construction`, `m` parameters) at very large scale (100M+ vectors). At typical enterprise document volumes (tens of thousands of chunks) PostgreSQL performs excellently.

---

### Hybrid BM25 + Vector search with RRF

**Decision:** Run both keyword (tsvector) and semantic (pgvector cosine) search in parallel and fuse with Reciprocal Rank Fusion.

**Benefits:** Improves recall from ~65% to ~91% recall@10. Keyword search catches exact matches (invoice numbers, names, dates, product codes) that embeddings semantically miss. BM25 is free — it uses PostgreSQL's built-in full-text search with no additional infrastructure.

**Tradeoff:** Two queries per search instead of one. In practice the overhead is 5–10ms — noise compared to the 300–800ms LLM calls that follow.

---

### LLM reranking with a fast model

**Decision:** After RRF retrieval, use `gpt-4o-mini` to score each candidate chunk 0–10 for relevance and return the top-K.

**Benefits:** Cross-encoder semantics — the model jointly attends to query and document, catching subtle relevance that bi-encoder cosine similarity misses. One batched API call regardless of candidate count.

**Tradeoff:** Adds ~300–500ms latency and one extra API call per search. Disable with `KNOWLEDGE_RERANK_ENABLED=false` when latency is more important than precision.

---

### LLM-based invoice extraction over regex

**Decision:** Use `gpt-4o-mini` to extract structured invoice fields from any document format.

**Benefits:** Works on expense tables, labeled PDFs, receipts, purchase orders, multi-currency reports — any format the LLM can read. Zero format-specific code to maintain.

**Tradeoff:** Adds one LLM call per invoice extraction. Falls back gracefully to a regex grand-total extractor if Azure is unavailable. Slower and more expensive than pure regex for a single known format, but far more reliable across real-world document variety.

---

### Validation guardrail that trusts chunks over LLM judgment

**Decision:** When `knowledge.retrieve` returned real chunks, the answer is allowed through even if the LLM validator marks it `partially_grounded` or `unsupported`. The guardrail only blocks when zero chunks were retrieved.

**Rationale:** The LLM validator itself can be wrong — it sometimes marks correct answers as unsupported because the claim is a paraphrase of the chunk text rather than verbatim. Completely suppressing answers when chunks exist creates a worse user experience than a soft caveat. The hard guardrail (replace with "I couldn't find information") fires only when there is genuinely nothing in the knowledge base to support the answer.

---

### JWT access + opaque refresh tokens

**Decision:** Short-lived JWTs (15 min) verified locally in each service via shared `JWT_ACCESS_SECRET`. Opaque refresh tokens stored as HMAC-SHA256 hashes in PostgreSQL with rotation on use.

**Benefits:** No inter-service token validation network hop on every request. Refresh token rotation invalidates stolen tokens on next use. Logout revokes the stored hash immediately.

**Tradeoff:** All services share `JWT_ACCESS_SECRET` — rotation requires coordinated restart. In production, replace with per-service asymmetric verification (public key distribution).

---

## 11. API Reference

### Auth Service (port 4001)

| Method | Path             | Description                          |
| ------ | ---------------- | ------------------------------------ |
| `POST` | `/auth/register` | Create user + tenant, returns tokens |
| `POST` | `/auth/login`    | Login, returns tokens                |
| `POST` | `/auth/refresh`  | Refresh access token                 |
| `POST` | `/auth/logout`   | Revoke refresh token                 |
| `GET`  | `/health`        | Health check                         |

### AI Gateway (port 4002)

| Method | Path           | Description                      |
| ------ | -------------- | -------------------------------- |
| `POST` | `/chat`        | Synchronous chat (full response) |
| `POST` | `/chat/stream` | SSE streaming chat               |
| `GET`  | `/chat/ws`     | WebSocket chat                   |
| `GET`  | `/health`      | Health check                     |

### Knowledge Service (port 4003)

| Method   | Path             | Description                               |
| -------- | ---------------- | ----------------------------------------- |
| `POST`   | `/documents`     | Upload PDF or TXT (`multipart/form-data`) |
| `GET`    | `/documents`     | List documents for tenant                 |
| `DELETE` | `/documents/:id` | Delete document + chunks                  |
| `POST`   | `/search`        | Semantic + keyword search                 |
| `GET`    | `/health`        | Health check                              |

### Tool Execution Service (port 4004)

| Method | Path             | Description                           |
| ------ | ---------------- | ------------------------------------- |
| `GET`  | `/tools`         | Get tool definitions (for AI Gateway) |
| `POST` | `/tools/execute` | Execute a tool                        |
| `GET`  | `/health`        | Health check                          |

---

## 12. Deployment

### Docker

Build all backend images:

```bash
pnpm docker:build:backend
```

Or individually:

```bash
pnpm docker:build:auth
pnpm docker:build:ai
pnpm docker:build:knowledge
pnpm docker:build:tools
```

Run the full stack:

```bash
docker compose up -d
```

### Kubernetes

Apply the base manifests:

```bash
kubectl apply -k infra/k8s/base
```

Scale a service:

```bash
kubectl scale deployment ai-gateway --replicas=3
kubectl scale deployment knowledge-service --replicas=2
```

### Environment secrets

In production, inject secrets via Kubernetes `Secret` resources or a secrets manager (AWS Secrets Manager, Azure Key Vault). Never commit `.env` files with real credentials.

Required secrets:

- `AZURE_OPENAI_API_KEY`
- `JWT_ACCESS_SECRET` (min 32 chars)
- `JWT_REFRESH_SECRET` (min 32 chars)
- # `DATABASE_URL`

# knoviq-assesment

> > > > > > > 447afa0399e3b576ba6282a28396a72407b0ec2b
