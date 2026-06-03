# Infrastructure

## Database

### PostgreSQL + pgvector

All application data lives in a single PostgreSQL database under the `knoviq` schema. The `pgvector` extension provides the `vector` data type and approximate nearest-neighbour indexes.

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
| `messages`               | AI Gateway     | User and assistant messages                  |
| `message_citations`      | AI Gateway     | Chunk citations per assistant message        |
| `llm_usage`              | AI Gateway     | Token counts, latency, estimated cost        |
| `tool_executions`        | Tool Execution | Per-execution input, output, status, latency |
| `service_metrics`        | All services   | Request counters and latency histograms      |

**Vector index**

`document_chunks.embedding` uses an HNSW index on cosine distance:

```sql
CREATE INDEX ON knoviq.document_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

HNSW handles write-heavy workloads without periodic re-indexing (unlike IVFFlat). For very large deployments (100M+ vectors), tune `m` and `ef_construction` based on recall benchmarks.

---

## Redis

Redis is a **cache only** — never the source of truth. On Redis failure or unavailability, all operations degrade gracefully to cache misses. PostgreSQL remains authoritative.

**What is cached**

| Cache                    | Key scope                                 | TTL  |
| ------------------------ | ----------------------------------------- | ---- |
| Knowledge search results | `(tenantId, userId, query, filters)` hash | 60s  |
| Tool definitions         | Tool service URL                          | 300s |

**Configuration**

```env
REDIS_URL=redis://localhost:6379
REDIS_ENABLED=true
CACHE_KEY_PREFIX=knoviq
CACHE_DEFAULT_TTL_SECONDS=60
```

Set `REDIS_ENABLED=false` to disable caching entirely. The `DisabledCacheClient` no-op implementation is used automatically — no code changes required.

**Invalidation**

When a user uploads a new document, the Knowledge Service deletes all search cache keys matching `knowledge:search:{tenantId}:{userId}:*`. This ensures the new document's chunks appear in subsequent search results.

---

## Kafka

Kafka receives domain events **after** PostgreSQL writes succeed. Kafka availability never affects user-facing request handling. All publish errors are swallowed silently.

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

Kafka message headers include `event-id`, `event-type`, `event-version`, and `service-name` for consumer-side filtering without deserialising the payload.

**Configuration**

```env
KAFKA_ENABLED=true
KAFKA_BROKERS=127.0.0.1:29092
KAFKA_CLIENT_ID=knoviq-local
KAFKA_TOPIC_PREFIX=knoviq
```

Set `KAFKA_ENABLED=false` to skip all event publishing. The `DisabledEventPublisher` no-op is used automatically.

**Production note**

Events are published after commit but not atomically with the database write. If a service writes to PostgreSQL and crashes before the Kafka publish, the event is lost. For exactly-once guarantees, add a transactional outbox table and a separate relay worker.

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

The `sql.query_safe` operation `service_metric_summary` exposes these to the agent.

### LLM usage

Every LLM call writes a row to `knoviq.llm_usage`:

| Field                | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `purpose`            | `tool_planning`, `answer_synthesis`, `validation`, `embedding` |
| `provider`           | `azure_openai` or `local`                                      |
| `model_deployment`   | Deployment name from Azure                                     |
| `prompt_tokens`      | Input token count                                              |
| `completion_tokens`  | Output token count                                             |
| `latency_ms`         | Round-trip time                                                |
| `estimated_cost_usd` | Calculated from cost-per-1k config                             |
| `cached`             | Whether the result came from embedding cache                   |

Cost defaults are zero. Set them from the active deployment price sheet:

```env
LLM_PROMPT_COST_PER_1K_TOKENS=0.00015
LLM_COMPLETION_COST_PER_1K_TOKENS=0.00060
```
