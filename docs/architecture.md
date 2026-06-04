# Architecture

## Overview

Knoviq is a microservices platform. Five independent services communicate over HTTP and share no in-process state. Each service has its own process, port, Docker image, and database connection pool.

The source code lives in a single repository (monorepo) for developer convenience — shared TypeScript packages, a single build pipeline, and atomic cross-service changes. The monorepo is a code organisation choice; it does not affect how services are deployed or scaled.

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Client (Browser)                             │
│                       Next.js 15  ·  port 3000                       │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  /api/auth  /api/chat  /api/documents
                             ▼
          ┌──────────────────────────────────────┐
          │              Web BFF                 │
          │  Next.js API routes proxy to services│
          └──────┬───────────────────┬───────────┘
                 │                   │
    ┌────────────▼──────┐   ┌────────▼──────────────┐
    │   Auth Service    │   │     AI Gateway        │
    │   port 4001       │   │     port 4002         │
    │                   │   │                       │
    │  Registration     │   │  Multi-agent chat     │
    │  Login / JWT      │   │  Planner → Tools →    │
    │  Refresh / Logout │   │  Synthesis → Validate │
    │  Tenant / RBAC    │   │                       │
    └───────────────────┘   └────────┬──────────────┘
                                     │ HTTP
              ┌──────────────────────┤
              │                      │
  ┌───────────▼────────┐   ┌─────────▼──────────────┐
  │  Knowledge Service │   │  Tool Execution Service│
  │  port 4003         │   │  port 4004             │
  │                    │◄──│                        │
  │  Document ingest   │   │  knowledge.retrieve    │
  │  Hybrid chunking   │   │  calculator.evaluate   │
  │  Embeddings        │   │  sql.query_safe        │
  │  BM25 + vector     │   │  extract_invoice_fields│
  │  LLM reranking     │   │  (LLM-based)           │
  └─────────┬──────────┘   └────────────────────────┘
            │
  ┌─────────┴──────────┐
  │    PostgreSQL      │
  │    + pgvector      │
  └─────────┬──────────┘
            │
  ┌─────────┴─────┐   ┌──────────────┐
  │    Redis      │   │    Kafka     │
  │   (cache)     │   │   (events)   │
  └───────────────┘   └──────────────┘
```

## Services

| Service                | Port | Responsibility                                                                                     |
| ---------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| Auth Service           | 4001 | User registration, login, JWT issuance, refresh token rotation, tenant and RBAC management         |
| AI Gateway             | 4002 | Multi-agent chat orchestration, conversation memory, tool calling, streaming, validation guardrail |
| Knowledge Service      | 4003 | Document ingestion, text extraction, hybrid chunking, embedding generation, hybrid search          |
| Tool Execution Service | 4004 | Safe tool execution — arithmetic, read-only SQL, knowledge retrieval, LLM invoice extraction       |
| Web Frontend           | 3000 | Next.js 15 App Router UI; API routes proxy requests to backend services                            |

## Shared Packages

Compiled libraries linked at build time. Zero runtime coupling — a package is a build-time dependency, not a shared process.

| Package                 | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `@knoviq/ai`            | `ToolName` enum, shared AI types                                    |
| `@knoviq/auth`          | JWT verification helpers                                            |
| `@knoviq/cache`         | Redis client (TTL, key prefix, graceful no-op fallback)             |
| `@knoviq/config`        | Zod-validated environment loader                                    |
| `@knoviq/contracts`     | Shared API schemas — health responses, error shapes, role enum      |
| `@knoviq/database`      | `pg` pool factory and `withTransaction` helper                      |
| `@knoviq/events`        | Kafka domain event publisher with `DisabledEventPublisher` fallback |
| `@knoviq/observability` | OpenTelemetry span helpers, `createTimer`, LLM cost estimation      |

## Data Boundaries

Each service owns its own schema tables. No service reads directly from another service's tables — cross-service data access goes through HTTP APIs.

| Service        | Owns tables                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| Auth           | `tenants`, `users`, `tenant_memberships`, `refresh_tokens`, `audit_logs`    |
| Knowledge      | `documents`, `document_access_grants`, `document_chunks`, `embedding_cache` |
| AI Gateway     | `conversations`, `messages`, `message_citations`, `llm_usage`               |
| Tool Execution | `tool_executions`                                                           |
| All services   | `service_metrics` (each writes its own rows)                                |

## Infrastructure

**PostgreSQL + pgvector** — primary data store. All services share one database server in development; in production each service should use its own connection pool pointed at the same or separate cluster.

**Redis** — acceleration cache only. Never the source of truth. Services degrade to cache misses on Redis failure. Disable entirely with `REDIS_ENABLED=false`.

**Kafka** — asynchronous event stream. Events are published after PostgreSQL writes succeed. Kafka failure does not affect user-facing responses. Disable with `KAFKA_ENABLED=false`.

## Security Boundaries

- Every service endpoint requires a JWT access token signed with `JWT_ACCESS_SECRET`.
- Tokens carry `sub` (userId), `tenant_id`, `role`, and `email`.
- Services verify the token locally — no network hop to Auth on every request.
- All repository queries filter by `tenant_id` extracted from the verified token.
- The `knowledge.retrieve` tool forwards the user's access token to the Knowledge Service, preserving document-level access control.
