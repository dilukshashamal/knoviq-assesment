# Deployment

## Local Development

See the main README for the full first-time setup. The short version:

```bash
corepack enable && corepack prepare pnpm@10.13.1 --activate
pnpm install
cp .env.example .env   # fill in AZURE_OPENAI_* and JWT secrets
docker compose up -d postgres redis kafka
pnpm build
```

Start services in separate terminals:

```bash
pnpm --filter @knoviq/auth-service start
pnpm --filter @knoviq/ai-gateway start
pnpm --filter @knoviq/knowledge-service start
pnpm --filter @knoviq/tool-execution-service start
pnpm --filter @knoviq/web dev
```

> **dev vs start**: `dev` uses `tsx watch` and reloads on file save. `start` runs compiled `dist/` — requires `pnpm build` after any source change.

---

## Docker

### Build images

All backend services share a single parameterised Dockerfile at `infra/docker/backend.Dockerfile`.

Build all four backend images:

```bash
pnpm docker:build:backend
```

Or individually:

```bash
pnpm docker:build:auth        # ghcr.io/<owner>/knoviq-auth-service
pnpm docker:build:ai          # ghcr.io/<owner>/knoviq-ai-gateway
pnpm docker:build:knowledge   # ghcr.io/<owner>/knoviq-knowledge-service
pnpm docker:build:tools       # ghcr.io/<owner>/knoviq-tool-execution-service
```

The Dockerfile compiles the requested workspace package and runs `dist/server.js` as the non-root `node` user.

### Run with Docker Compose

```bash
docker compose up -d
```

The Compose file starts all services, PostgreSQL, Redis, and Kafka. Suitable for integration testing and staging.

---

## Kubernetes

Base manifests live at `infra/k8s/base`.

### Included resources

| Resource                     | Description                                          |
| ---------------------------- | ---------------------------------------------------- |
| `namespace.yaml`             | `knoviq` namespace                                   |
| `configmap.yaml`             | Non-secret environment configuration                 |
| `secret.example.yaml`        | Template for required secrets (fill before applying) |
| `postgres/`                  | PostgreSQL StatefulSet + Service                     |
| `redis/`                     | Redis Deployment + Service                           |
| `migrations/`                | One-shot migration Job                               |
| `*/deployment.yaml`          | Deployment + Service for each backend                |
| `knowledge-service/pvc.yaml` | PersistentVolumeClaim for document uploads           |

### Apply

```bash
# 1. Create namespace
kubectl apply -f infra/k8s/base/namespace.yaml

# 2. Fill in secret.example.yaml and apply as knoviq-secrets
kubectl apply -f your-secrets.yaml -n knoviq

# 3. Create migration ConfigMap from SQL files
kubectl create configmap knoviq-migrations \
  --from-file=infra/migrations \
  -n knoviq --dry-run=client -o yaml | kubectl apply -f -

# 4. Apply the full base
kubectl apply -k infra/k8s/base
```

### Scaling

Each service scales independently:

```bash
kubectl scale deployment ai-gateway --replicas=3 -n knoviq
kubectl scale deployment knowledge-service --replicas=2 -n knoviq
kubectl scale deployment tool-execution-service --replicas=2 -n knoviq
```

Auth Service and Web are stateless and scale horizontally with no additional configuration.

### Production recommendations

- Use **managed PostgreSQL** (Azure Database for PostgreSQL, AWS RDS) instead of the in-cluster StatefulSet.
- Use **managed Redis** (Azure Cache for Redis, ElastiCache) instead of the in-cluster Deployment.
- Use **managed Kafka** (Azure Event Hubs with Kafka surface, Confluent Cloud, MSK) instead of the in-cluster broker.
- Store secrets in a secret manager (Azure Key Vault, AWS Secrets Manager) and inject them via the secrets CSI driver or external-secrets operator.

---

## CI/CD

### Continuous Integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`.

| Job         | Steps                                             |
| ----------- | ------------------------------------------------- |
| `quality`   | Install → format check → build → lint → typecheck |
| `docker`    | Buildx `--check` for all four backend Dockerfiles |
| `manifests` | `kubectl kustomize infra/k8s/base` render check   |

### Container Publishing

`.github/workflows/container-publish.yml` builds and pushes images to GitHub Container Registry.

**Triggers:** manual `workflow_dispatch` or semver tags (`v0.1.0`).

**Published images:**

```
ghcr.io/<owner>/knoviq-auth-service:<tag>
ghcr.io/<owner>/knoviq-ai-gateway:<tag>
ghcr.io/<owner>/knoviq-knowledge-service:<tag>
ghcr.io/<owner>/knoviq-tool-execution-service:<tag>
```

Each image is tagged with both the git tag and a `sha-...` digest tag for traceability.

### Cluster deployment

The publish workflow pushes images only. Cluster deployment is intentionally separate — it requires environment-specific credentials, approval gates, and secret management. Implement it as a protected GitHub Environment with required reviewers once the target cluster is ready.

---

## Smoke Test

Verify the full invoice agent pipeline end-to-end without mocking:

```bash
pnpm smoke:invoice
```

This command builds the repo, applies migrations, starts all four backend services, uploads a sample invoice document, sends a chat request, and asserts that the agent correctly retrieves, extracts, calculates, and validates the invoice total. Redis, Kafka, and OpenTelemetry are disabled so only a local PostgreSQL is required.
