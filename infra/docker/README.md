# Docker Foundation

This folder will hold reusable Dockerfiles and service-specific runtime notes as the backend services are implemented.

Task 1 starts with infrastructure dependencies in the root `docker-compose.yml`:

- PostgreSQL with pgvector
- Redis for caching and rate limiting

PostgreSQL 18 Docker images expect the persistent volume at
`/var/lib/postgresql`. Mounting only `/var/lib/postgresql/data` can make the
container restart during initialization because the 18+ images use
major-version-specific data directories.
