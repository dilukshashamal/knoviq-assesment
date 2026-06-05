# Services Reference

## Auth Service · port 4001

Owns user registration, authentication, JWT issuance, refresh token rotation, and tenant/RBAC
management.

### Endpoints

| Method   | Path                               | Description                                             |
| -------- | ---------------------------------- | ------------------------------------------------------- |
| `POST`   | `/auth/register`                   | Create user + tenant, returns access and refresh tokens |
| `POST`   | `/auth/login`                      | Login with email + password, returns tokens             |
| `POST`   | `/auth/refresh`                    | Rotate refresh token, return new access token           |
| `POST`   | `/auth/logout`                     | Revoke refresh token                                    |
| `GET`    | `/auth/me`                         | Current user profile                                    |
| `GET`    | `/tenants`                         | List tenants the user belongs to                        |
| `GET`    | `/tenants/current/members`         | List members of the active tenant                       |
| `POST`   | `/tenants/current/members`         | Add an existing user to the tenant                      |
| `PATCH`  | `/tenants/current/members/:userId` | Change a member's role                                  |
| `DELETE` | `/tenants/current/members/:userId` | Remove a member                                         |
| `GET`    | `/health`                          | Health check                                            |

### Security model

Passwords are hashed with **Argon2id**. Refresh tokens are opaque random values; only HMAC-SHA256
hashes are stored in PostgreSQL. Access tokens are JWTs signed with HS256 via `jose` and contain
`sub`, `tenant_id`, `role`, `email`, and `jti`.

Registration creates a tenant, a user, and an `owner` membership in one transaction.

Refresh rotation revokes the previous token on use, limiting replay value if a token leaks.

### RBAC

Role hierarchy (highest to lowest): `owner` → `admin` → `member` → `viewer`.

| Action                            | Required role              |
| --------------------------------- | -------------------------- |
| List members                      | `admin` or `owner`         |
| Add member as viewer/member/admin | `admin` or `owner`         |
| Add/remove/promote/demote owner   | `owner` only               |
| Remove last owner                 | Blocked — always prevented |

---

## AI Gateway · port 4002

Owns chat orchestration, conversation memory, multi-agent workflow, tool calling, streaming, and
answer validation.

### Endpoints

| Method | Path           | Description                              |
| ------ | -------------- | ---------------------------------------- |
| `POST` | `/chat`        | Synchronous chat — returns full response |
| `POST` | `/chat/stream` | Server-Sent Events streaming             |
| `GET`  | `/chat/ws`     | WebSocket bidirectional streaming        |
| `GET`  | `/health`      | Health check                             |

### Agent workflow

Each chat turn runs four phases:

1. **Planner** (`gpt-4o-mini`, temp=0) — selects tool calls from available definitions. KB-first
   rule: always retrieves from the knowledge base for factual questions. Mandatory safety net injects
   a retrieval call if the planner returns none.
2. **Tool agents** — execute each tool call through the Tool Execution Service, with up to 4
   follow-up chaining rounds.
3. **Synthesizer** (`gpt-4o`, temp=0.1) — produces a grounded answer from chunk citations and tool
   outputs. Raw RRF scores are excluded from the context to prevent them from being misread as
   relevance signals.
4. **Validator** (`gpt-4o-mini`, temp=0) — checks every factual claim against retrieved chunks.
   Returns `grounded`, `partially_grounded`, or `unsupported`. Paraphrase counts as grounded.

### Streaming events

All three transport options (HTTP, SSE, WebSocket) emit the same structured events:

| Event type     | Payload                             |
| -------------- | ----------------------------------- |
| `conversation` | `{ conversationId }`                |
| `agent_step`   | `{ agent, status, toolCallCount? }` |
| `message`      | `{ messageId, role }`               |
| `tool_start`   | `{ toolName, arguments, reason }`   |
| `tool_result`  | Tool execution result               |
| `validation`   | `{ status, confidence, issues }`    |
| `final`        | Full `AgentRunResult`               |
| `error`        | `{ message }`                       |

### WebSocket auth

HTTP header: `Authorization: Bearer <token>`

Query param (for runtimes that don't support auth headers on WS): `?accessToken=<token>`

### Model providers

| Variable                    | Value   | Behaviour                                                            |
| --------------------------- | ------- | -------------------------------------------------------------------- |
| `AI_GATEWAY_MODEL_PROVIDER` | `azure` | Production — uses Azure OpenAI                                       |
| `AI_GATEWAY_MODEL_PROVIDER` | `local` | Development — deterministic responses, no Azure credentials required |

---

## Knowledge Service · port 4003

Owns document ingestion, text extraction, hybrid chunking, embedding generation, and hybrid
semantic + keyword search.

### Endpoints

| Method   | Path             | Description                                    |
| -------- | ---------------- | ---------------------------------------------- |
| `POST`   | `/documents`     | Upload PDF or TXT (`multipart/form-data`)      |
| `GET`    | `/documents`     | List documents for the authenticated tenant    |
| `DELETE` | `/documents/:id` | Delete document and all its chunks             |
| `POST`   | `/search`        | Hybrid BM25 + vector search with LLM reranking |
| `GET`    | `/health`        | Health check                                   |

### Upload fields

| Field        | Required | Description                          |
| ------------ | -------- | ------------------------------------ |
| `file`       | Yes      | PDF or TXT file                      |
| `title`      | No       | Display title (defaults to filename) |
| `visibility` | No       | `private`, `tenant`, or `shared`     |
| `metadata`   | No       | JSON object with custom fields       |

### Document access

All queries filter by authenticated tenant, active membership, and one of:

- document owner
- document visibility = `tenant`
- explicit `document_access_grants` row for the user

### Embedding providers

| Variable                       | Value   | Behaviour                                         |
| ------------------------------ | ------- | ------------------------------------------------- |
| `KNOWLEDGE_EMBEDDING_PROVIDER` | `azure` | Production — Azure `text-embedding-3-small`       |
| `KNOWLEDGE_EMBEDDING_PROVIDER` | `local` | Development — deterministic SHA-256-based vectors |

---

## Tool Execution Service · port 4004

Owns safe tool execution and execution logging. All tools are validated, parameterised, and
tenant-aware.

### Endpoints

| Method | Path             | Description                                        |
| ------ | ---------------- | -------------------------------------------------- |
| `GET`  | `/tools`         | Return tool definitions for the AI Gateway planner |
| `POST` | `/tools/execute` | Execute a named tool with validated arguments      |
| `GET`  | `/health`        | Health check                                       |

### Startup behaviour

On every service startup, any tool execution rows still in `running` status and older than 10
minutes are automatically marked `failed` with `error_code: process_interrupted`. This recovers
orphaned rows from previous process crashes and prevents them from skewing the monitoring dashboard.

### Tools

#### `knowledge.retrieve`

Forwards a validated retrieval request to the Knowledge Service using the caller's access token.
Preserves tenant and document access control end-to-end.

Arguments: `query` (required), `documentIds` (optional filter), `limit`, `minSimilarity`.

#### `calculator.evaluate`

Safe arithmetic evaluator. Uses a custom recursive descent parser — no `eval`, no code execution.
Supports `+`, `-`, `*`, `/`, `^`, and parentheses.

Arguments: `expression` (string), `precision` (decimal places, optional).

#### `sql.query_safe`

Read-only SQL against approved, parameterised operations. The LLM selects an operation name; it
never provides raw SQL. Completed and failed executions are returned; in-progress executions are
excluded to avoid self-referential race conditions.

Approved operations:

| Operation                  | What it returns                                     |
| -------------------------- | --------------------------------------------------- |
| `document_count`           | Document count by status                            |
| `list_documents`           | Recent documents with metadata                      |
| `llm_usage_summary`        | Token counts and cost by model and purpose          |
| `tool_execution_summary`   | Tool call counts and latency by tool and status     |
| `recent_tool_executions`   | Latest tool calls with status and latency           |
| `service_metric_summary`   | Request counts and latency histograms by service    |
| `answer_validation_summary`| Answer counts by validation status and confidence   |
| `answer_quality_incidents` | Non-grounded answers with full trace for review     |
| `answer_quality_trend`     | Daily time series of validation status over 30 days |

#### `document.extract_invoice_fields`

LLM-based invoice extraction. Uses `AZURE_OPENAI_CHAT_DEPLOYMENT_FAST` to read any invoice
format — expense tables, labeled PDFs, receipts, multi-currency reports — and extract:

- `invoiceNumber`, `vendor`, `invoiceDate`, `description`, `amount`, `currency`, `approvalStatus`
- `grandTotal` — from the document's own verified summary section when present
- `periodLabel` — detected period from the document

Returns per-invoice rows plus an aggregated `totalAmount` for the requested period. Falls back
gracefully to a regex grand-total extractor if Azure is unavailable.

### Execution logging

Every tool execution is recorded in `knoviq.tool_executions` with: tool name, arguments, output,
status, error code/message, request ID, tenant ID, user ID, conversation ID, and latency.

---

## Web Frontend · port 3000

Next.js 15 App Router application. API routes act as a Backend-for-Frontend (BFF), proxying
requests to backend services while forwarding the user's JWT.

### API routes

| Method   | Path                        | Proxies to                        |
| -------- | --------------------------- | --------------------------------- |
| `POST`   | `/api/auth/register`        | Auth Service `/auth/register`     |
| `POST`   | `/api/auth/login`           | Auth Service `/auth/login`        |
| `POST`   | `/api/chat`                 | AI Gateway `/chat`                |
| `POST`   | `/api/documents`            | Knowledge Service `/documents`    |
| `GET`    | `/api/documents`            | Knowledge Service `/documents`    |
| `DELETE` | `/api/documents/:id`        | Knowledge Service `/documents/:id`|
| `GET`    | `/api/health`               | All four backend health endpoints |
| `GET`    | `/api/observability`        | Tool Execution Service (7 SQL ops)|

### Admin console

`/admin/monitoring` — available to `owner` and `admin` roles only. Displays:

- Service readiness (health checks)
- Answer quality pulse — unsupported rate, high-priority review count, retrieval misses
- **Answer review inbox** — non-grounded answers from the last 30 days with full evidence trail
  (user question, draft answer, tool calls, retrieval results, validation findings). Admins can
  mark each incident as Bad answer / Retrieval issue / Validator false alarm / Resolved.
- 30-day quality trend chart
- AI usage and cost by model and purpose
- Background job health (tool execution summary)
- Service response latency
- Recent job activity

### Chat thread isolation

Chat threads are stored in `localStorage` under a per-user key
(`knoviq.chatThreads.<userId>`). Users on the same device never see each other's threads.
Thread state is reset on sign-in and sign-out.
