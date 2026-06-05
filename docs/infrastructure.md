# Infrastructure

## Database

### PostgreSQL + pgvector

All application data lives in a single PostgreSQL database under the `knoviq` schema. The
`pgvector` extension provides the `vector` data type and approximate nearest-neighbour indexes.

**Schema tables**

| Table                    | Owner service  | Purpose                                      |
| ------------------------ | -------------- | -------------------------------------------- |
| `tenants`                | Auth           | Tenant identity and status                   |
| `users`                  | Auth           | User accounts with Argon2id password hashes  |
| `tenant_memberships`     | Auth           | Role-based tenant membership                 |
| `refresh_tokens`         | Auth           | HMAC-SHA256 hashed opaque tokens             |
| `audit_logs`             | Auth           | Security-sensitive event log                 |
| `documents`              | Knowledge      | Document metadata and ingest status          |
| `document_access_grants` | Knowledge      | Per-user document sharing                    |
| `document_chunks`        | Knowledge      | Chunk content + `embedding::vector(1536)`    |
| `embedding_cache`        | Knowledge      | Content-hash → vector deduplication cache    |
| `conversations`          | AI Gateway     | Conversation sessions                        |
| `messages`               | AI Gateway     | User and assistant messages with metadata    |
| `message_citations`      | AI Gateway     | Chunk citations per assistant message        |
| `llm_usage`              | AI Gateway     | Token counts, latency, estimated cost        |
| `tool_executions`        | Tool Execution | Per-execution input, output, status, latency |
| `service_metrics`        | All services   | Request counters and latency histograms      |

The `messages.metadata` JSONB column stores the full agent trace per assistant message: tool calls
with outputs, validation status/confidence/issues, and the draft answer before the guardrail. This
powers the admin quality review inbox without requiring a separate table.

**Vector index**

`document_chunks.embedding` uses an HNSW index on cosine distance:

```sql
CREATE INDEX ON knoviq.document_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

HNSW handles write-heavy workloads without periodic re-indexing (unlike IVFFlat). For very large
deployments (100M+ vectors), tune `m` and `ef_construction` based on recall benchmarks.

---

## Redis

Redis is a **cache only** — never the source of truth. On Redis failure or unavailability, all
operations degrade gracefully to cache misses. PostgreSQL remains authoritative.

**What is cached**

| Cache                    | Key scope                                    | TTL  |
| ------------------------ | -------------------------------------------- | ---- |
| Knowledge search results | `(tenantId, userId, query, filters)` hash    | 60s  |
| Tool definitions         | Tool service URL                             | 300s |

**Cache client improvements**

- Redis errors are logged to stderr at warn level so ops can detect broker issues
- The `ready` event clears `connectPromise` so reconnects after drops are handled cleanly
- `deleteByPattern` uses `UNLINK` (non-blocking) instead of `DEL`

**Configuration**

```env
REDIS_URL=redis://localhost:6379
REDIS_ENABLED=true
CACHE_KEY_PREFIX=knoviq
CACHE_DEFAULT_TTL_SECONDS=60
```

Set `REDIS_ENABLED=false` to disable caching entirely. The `DisabledCacheClient` no-op
implementation is used automatically — no code changes required.

**Invalidation**

When a user uploads or deletes a document, the Knowledge Service deletes all search cache keys
matching `knowledge:search:{tenantId}:{userId}:*`. This ensures the new document's chunks appear
in subsequent search results immediately.

---

## Kafka

Kafka receives domain events **after** PostgreSQL writes succeed. Kafka availability never affects
user-facing request handling.

**Kafka client improvements**

- Uses `Partitioners.LegacyPartitioner` (correct for KafkaJS v2 — `DefaultPartitioner` is
  deprecated in v2 and emits warnings)
- Producer `disconnect` event clears `connectPromise` so reconnects after broker failures are
  attempted on the next publish
- Publish failures are logged to stderr at warn level for ops visibility
- `allowAutoTopicCreation` is disabled in production (`NODE_ENV=production`) to prevent typos
  from silently creating phantom topics
- `shutdown()` awaits any in-flight connect before disconnecting

**Topics**

| Topic                    | Events                                                      |
| ------------------------ | ----------------------------------------------------------- |
| `knoviq.documents`       | `knowledge.document.uploaded`, `knowledge.document.deleted` |
| `knoviq.conversations`   | `conversation.created`, `conversation.message.created`      |
| `knoviq.agent-runs`      | `agent.run.completed`                                       |
| `knoviq.llm-usage`       | `llm.usage.recorded`                                        |
| `knoviq.tool-executions` | `tool.execution.completed`                                  |

**Event envelope**

```json
{
  "eventId": "uuid",
  "eventType": "knowledge.document.uploaded",
  "eventVersion": 1,
  "occurredAt": "2026-06-03T10:00:00.000Z",
  "serviceName": "knowledge-service",
  "tenantId": "uuid",
  "userId": "uuid",
  "requestId": "knowledge-service-...",
  "data": {}
}
```

Kafka message headers include `event-id`, `event-type`, `event-version`, and `service-name` for
consumer-side filtering without deserialising the payload.

**Configuration**

```env
KAFKA_ENABLED=true
KAFKA_BROKERS=127.0.0.1:29092
KAFKA_CLIENT_ID=knoviq-local
KAFKA_TOPIC_PREFIX=knoviq
```

Set `KAFKA_ENABLED=false` to skip all event publishing. The `DisabledEventPublisher` no-op is
used automatically.

**Production note**

Events are published after commit but not atomically with the database write. If a service writes
to PostgreSQL and crashes before the Kafka publish, the event is lost. For exactly-once guarantees,
implement a transactional outbox: write an event row in the same database transaction, then have
a relay worker publish it to Kafka and mark it sent.

---

## Observability

### OpenTelemetry traces

Each backend service initialises the OpenTelemetry SDK at startup.

```env
OTEL_TRACES_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://collector:4318/v1/traces
```

Disabled by default (`OTEL_TRACES_ENABLED=false`). When enabled, the AI Gateway emits spans for:

- `agent.tool_planning` — planner LLM call
- `agent.tool_call.<tool_name>` — per-tool execution
- `agent.answer_synthesis` — synthesizer LLM call
- `agent.answer_validation` — validator LLM call

### Request metrics

All services write Fastify request metrics to `knoviq.service_metrics`:

- `http.server.requests` — counter, labelled by method, route, status code
- `http.server.duration` — histogram in milliseconds

The `sql.query_safe` operation `service_metric_summary` exposes these to the agent and admin
console.

### LLM usage and cost

Every LLM call writes a row to `knoviq.llm_usage`:

| Field                | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `purpose`            | `tool_planning`, `answer_synthesis`, `validation`, `embedding` |
| `provider`           | `azure_openai` or `local`                                      |
| `model_deployment`   | Deployment name from Azure                                     |
| `prompt_tokens`      | Input token count                                              |
| `completion_tokens`  | Output token count                                             |
| `total_tokens`       | Generated column: `prompt_tokens + completion_tokens`          |
| `latency_ms`         | Round-trip time                                                |
| `estimated_cost_usd` | Calculated at write time using configured cost rates           |
| `cached`             | Whether the result came from embedding cache                   |

**Per-model cost estimation**

The `@knoviq/observability` package maintains a built-in pricing table keyed by deployment name
substring. This ensures `gpt-4o` synthesis calls are priced at the correct rate
($0.0025/$0.01 per 1k tokens) rather than the cheaper `gpt-4o-mini` rate ($0.00015/$0.00060).

Known models and their rates (June 2026):

| Model                     | Prompt /1k | Completion /1k |
| ------------------------- | ---------- | -------------- |
| `gpt-4o-mini`             | $0.00015   | $0.00060       |
| `gpt-4o`                  | $0.00250   | $0.01000       |
| `text-embedding-3-small`  | $0.00002   | $0             |
| `text-embedding-3-large`  | $0.00013   | $0             |

The env vars `LLM_PROMPT_COST_PER_1K_TOKENS` and `LLM_COMPLETION_COST_PER_1K_TOKENS` are a
fallback for unknown deployments not in the built-in table. Set both to `0` to disable cost
recording for unknown deployments.

The admin monitoring page computes cost client-side using the same pricing table, so historical
rows with `estimated_cost_usd = 0` (written before pricing was configured) are correctly displayed.

### Admin monitoring

The admin console at `/admin/monitoring` (owner and admin roles only) provides:

- **Service readiness** — live health checks for all four backend services
- **Answer quality pulse** — unsupported rate, high-priority incident count, retrieval miss count
- **Answer review inbox** — non-grounded answers from the last 30 days with full evidence trail
  for admin triage. Review decisions (bad answer / retrieval issue / validator false alarm /
  resolved) are stored in `localStorage` per tenant.
- **30-day quality trend** — daily bar chart of unsupported answer rate
- **AI usage** — token counts and cost by model and purpose
- **Background jobs** — tool execution counts by tool and status (in-progress executions excluded)
- **Service response** — average and peak latency per service
- **Recent activity** — latest tool executions with status and latency
