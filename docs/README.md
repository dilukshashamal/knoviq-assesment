# Knoviq Documentation

| Document                                 | What it covers                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| [architecture.md](./architecture.md)     | System overview, service boundaries, data ownership, security model                         |
| [rag-pipeline.md](./rag-pipeline.md)     | Document ingestion, hybrid chunking, BM25 + vector search, LLM reranking, answer generation |
| [tool-calling.md](./tool-calling.md)     | Tool calling flow, invoice chaining, SQL safety, execution lifecycle                        |
| [services.md](./services.md)             | API reference for all five services with endpoint tables                                    |
| [multi-tenancy.md](./multi-tenancy.md)   | Tenant model, RBAC, isolation pattern, document access control                              |
| [infrastructure.md](./infrastructure.md) | PostgreSQL schema, Redis caching, Kafka events, observability                               |
| [deployment.md](./deployment.md)         | Local setup, Docker, Kubernetes, CI/CD, smoke test                                          |
| [decisions.md](./decisions.md)           | Architecture decision records — what was chosen, why, and tradeoffs                         |
