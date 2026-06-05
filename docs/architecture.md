# Architecture

## Overview

Knoviq is a microservices platform. Five application services communicate over HTTP and share no
in-process state. Each service has its own process, port, Docker image, and database connection
pool.

The source code lives in a single repository for developer convenience: shared TypeScript packages,
a single build pipeline, and atomic cross-service changes. The monorepo is a code organisation
choice; it does not affect how services are deployed or scaled.

```text
Client browser
  |
  | http://localhost:3000
  v
Web Frontend / BFF (Next.js 16, port 3000)
  |-- /api/auth       -> Auth Service (4001)
  |-- /api/chat       -> AI Gateway (4002)
  |-- /api/documents  -> Knowledge Service (4003)
  |-- /api/health     -> all backend health endpoints
  |-- /api/observability -> Tool Execution Service (4004)

Auth Service
  |-- PostgreSQL

AI Gateway
  |-- Tool Execution Service
  |-- PostgreSQL
  |-- Redis
  |-- Kafka

Knowledge Service
  |-- PostgreSQL + pgvector
  |-- Redis
  |-- Kafka

Tool Execution Service
  |-- Knowledge Service
  |-- PostgreSQL
  |-- Kafka
```

## Services

| Service                | Port | Responsibility                                                                                     |
| ---------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| Web Frontend           | 3000 | Next.js 16 App Router UI; API routes proxy requests to backend services                            |
| Auth Service           | 4001 | User registration, login, JWT issuance, refresh token rotation, tenant and RBAC management         |
| AI Gateway             | 4002 | Multi-agent chat orchestration, conversation memory, tool calling, streaming, validation guardrail |
| Knowledge Service      | 4003 | Document ingestion, text extraction, hybrid chunking, embedding generation, hybrid search          |
| Tool Execution Service | 4004 | Safe tool execution: arithmetic, read-only SQL, knowledge retrieval, LLM invoice extraction        |

## Local Container Topology

Docker Compose uses the `app` profile for application containers:

| Container                      | Image                                 | Dockerfile                         |
| ------------------------------ | ------------------------------------- | ---------------------------------- |
| `knoviq-web`                   | `knoviq/web:0.1.0`                    | `infra/docker/web.Dockerfile`      |
| `knoviq-auth`                  | `knoviq/auth-service:0.1.0`           | `infra/docker/backend.Dockerfile`  |
| `knoviq-ai-gateway`            | `knoviq/ai-gateway:0.1.0`             | `infra/docker/backend.Dockerfile`  |
| `knoviq-knowledge`             | `knoviq/knowledge-service:0.1.0`      | `infra/docker/backend.Dockerfile`  |
| `knoviq-tools`                 | `knoviq/tool-execution-service:0.1.0` | `infra/docker/backend.Dockerfile`  |

The web container talks to backend containers by Compose service name, not `localhost`.

## Shared Packages

Compiled libraries are linked at build time. A package is a build-time dependency, not a shared
runtime process.

| Package                 | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `@knoviq/ai`            | `ToolName` enum, shared AI types                                    |
| `@knoviq/auth`          | JWT verification helpers                                            |
| `@knoviq/cache`         | Redis client with TTL, key prefix, and graceful no-op fallback      |
| `@knoviq/config`        | Zod-validated environment loader                                    |
| `@knoviq/contracts`     | Shared API schemas: health responses, error shapes, role enum       |
| `@knoviq/database`      | `pg` pool factory and `withTransaction` helper                      |
| `@knoviq/events`        | Kafka domain event publisher with `DisabledEventPublisher` fallback |
| `@knoviq/observability` | OpenTelemetry span helpers, `createTimer`, LLM cost estimation      |

## Data Boundaries

Each service owns its own schema tables. No service reads directly from another service's tables;
cross-service data access goes through HTTP APIs.

| Service        | Owns tables                                                                 |
| -------------- | --------------------------------------------------------------------------- |
| Auth           | `tenants`, `users`, `tenant_memberships`, `refresh_tokens`, `audit_logs`    |
| Knowledge      | `documents`, `document_access_grants`, `document_chunks`, `embedding_cache` |
| AI Gateway     | `conversations`, `messages`, `message_citations`, `llm_usage`               |
| Tool Execution | `tool_executions`                                                           |
| All services   | `service_metrics` (each writes its own rows)                                |

## Infrastructure

PostgreSQL + pgvector is the primary data store. All services share one database server in
development; in production each service should use its own connection pool pointed at the same or a
separate cluster.

Redis is an acceleration cache only. It is never the source of truth. Services degrade to cache
misses on Redis failure. Disable it with `REDIS_ENABLED=false`.

Kafka is the asynchronous event stream. Events are published after PostgreSQL writes succeed. Kafka
failure does not affect user-facing responses. Disable it with `KAFKA_ENABLED=false`.

## Security Boundaries

- Every service endpoint requires a JWT access token signed with `JWT_ACCESS_SECRET`.
- Tokens carry `sub` (userId), `tenant_id`, `role`, and `email`.
- Services verify the token locally; there is no network hop to Auth on every request.
- All repository queries filter by `tenant_id` extracted from the verified token.
- The `knowledge.retrieve` tool forwards the user's access token to the Knowledge Service,
  preserving document-level access control.
