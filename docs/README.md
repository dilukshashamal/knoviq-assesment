# Knoviq Documentation

## Current Startup

Run the full Docker stack, including the Next.js frontend:

```powershell
docker compose --profile app up -d --build
```

Open the frontend at [http://localhost:3000](http://localhost:3000).

Useful checks:

```powershell
docker ps
docker compose logs -f
```

Stop the stack:

```powershell
corepack pnpm docker:down
```

For infrastructure only, without app containers:

```powershell
corepack pnpm docker:up
```

For local frontend development while Docker runs the backend services:

```powershell
docker compose --profile app up -d auth-service ai-gateway knowledge-service tool-execution-service
corepack pnpm --filter @knoviq/web dev
```

| Document                                 | What it covers                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| [architecture.md](./architecture.md)     | System overview, service boundaries, data ownership, security model                         |
| [rag-pipeline.md](./rag-pipeline.md)     | Document ingestion, hybrid chunking, BM25 + vector search, LLM reranking, answer generation |
| [tool-calling.md](./tool-calling.md)     | Tool calling flow, invoice chaining, SQL safety, execution lifecycle                        |
| [services.md](./services.md)             | API reference for all five services including admin monitoring and web BFF                  |
| [multi-tenancy.md](./multi-tenancy.md)   | Tenant model, RBAC, isolation pattern, document access control                              |
| [infrastructure.md](./infrastructure.md) | PostgreSQL schema, Redis caching, Kafka events, LLM cost estimation, observability          |
| [deployment.md](./deployment.md)         | Local setup, Docker, Kubernetes, CI/CD, smoke test                                          |
| [decisions.md](./decisions.md)           | Architecture decision records — what was chosen, why, and tradeoffs                         |
