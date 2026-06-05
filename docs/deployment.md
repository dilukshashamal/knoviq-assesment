# Deployment

## Local Development

See `docs/README.md` for the current start commands. The short first-time setup is:

```bash
corepack enable && corepack prepare pnpm@10.13.1 --activate
pnpm install
cp .env.example .env   # fill in AZURE_OPENAI_* and JWT secrets
docker compose up -d postgres redis kafka
pnpm build
```

Start services in separate terminals:

```bash
pnpm --filter @knoviq/auth-service dev
pnpm --filter @knoviq/ai-gateway dev
pnpm --filter @knoviq/knowledge-service dev
pnpm --filter @knoviq/tool-execution-service dev
pnpm --filter @knoviq/web dev
```

Backend `dev` scripts use `tsx watch` and reload on file save. Backend `start` runs compiled
`dist/` and requires `pnpm build` after source changes. The web app uses Next.js dev mode on port 3000.

---

## Docker

### Build Images

Backend services share a single parameterised Dockerfile at `infra/docker/backend.Dockerfile`.
The web frontend uses `infra/docker/web.Dockerfile` and Next.js standalone output.

Build the full application image set:

```bash
pnpm docker:build:app
```

Build all four backend images only:

```bash
pnpm docker:build:backend
```

Or build individually:

```bash
pnpm docker:build:auth
pnpm docker:build:ai
pnpm docker:build:knowledge
pnpm docker:build:tools
pnpm docker:build:web
```

The backend Dockerfile compiles the requested workspace package, performs a production-only
`pnpm deploy` using the warmed BuildKit pnpm store, and runs `dist/server.js` as the non-root
`node` user. The web Dockerfile builds `@knoviq/web` with `output: "standalone"` and runs the
generated Next.js server as the non-root `node` user.

### Run With Docker Compose

Run the full local stack, including frontend, backend services, PostgreSQL, Redis, and Kafka:

```bash
docker compose --profile app up -d --build
```

Open the frontend at `http://localhost:3000`.

Run infrastructure only:

```bash
pnpm docker:up
```

Run the backend app containers without the web container, useful when running the frontend locally:

```bash
docker compose --profile app up -d auth-service ai-gateway knowledge-service tool-execution-service
pnpm --filter @knoviq/web dev
```

Stop everything:

```bash
pnpm docker:down
```

Application container healthchecks use Node's built-in `fetch`, so the slim Node runtime images do
not need `wget` or `curl`.

---

## Kubernetes

Base manifests live at `infra/k8s/base`.

### Included Resources

| Resource                | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `namespace.yaml`        | `knoviq` namespace                                   |
| `configmap.yaml`        | Non-secret environment configuration                 |
| `secret.example.yaml`   | Template for required secrets (fill before applying) |
| `postgres.yaml`         | PostgreSQL StatefulSet + Service                     |
| `redis.yaml`            | Redis Deployment + Service                           |
| `kafka.yaml`            | Kafka broker Deployment + Service                    |
| `migration-job.yaml`    | One-shot migration Job                               |
| `backend-services.yaml` | PVC plus Deployment + Service for each backend       |
| `kustomization.yaml`    | Kustomize base that renders all resources            |

The current Kubernetes base deploys the four backend services and supporting infrastructure. The
Next.js web app is currently covered by Docker Compose and `infra/docker/web.Dockerfile`; add a web
Deployment/Service before using Kubernetes as the full production runtime.

### Apply

```bash
kubectl apply -f infra/k8s/base/namespace.yaml
kubectl apply -f your-secrets.yaml -n knoviq
kubectl create configmap knoviq-migrations \
  --from-file=infra/migrations \
  -n knoviq --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -k infra/k8s/base
```

### Scaling

Each service scales independently:

```bash
kubectl scale deployment ai-gateway --replicas=3 -n knoviq
kubectl scale deployment knowledge-service --replicas=2 -n knoviq
kubectl scale deployment tool-execution-service --replicas=2 -n knoviq
```

Auth Service is stateless and scales horizontally with no additional configuration. The web app is
also stateless, but it does not yet have a Kubernetes manifest in `infra/k8s/base`.

### Production Recommendations

- Use managed PostgreSQL instead of the in-cluster StatefulSet.
- Use managed Redis instead of the in-cluster Deployment.
- Use managed Kafka instead of the in-cluster broker.
- Store secrets in a secret manager and inject them via the secrets CSI driver or external-secrets.

---

## CI/CD

### Continuous Integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`.

| Job         | Steps                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| `quality`   | Install -> format check -> build -> lint -> typecheck -> test                |
| `docker`    | Buildx `--check` for the backend Dockerfile across all four backend services |
| `manifests` | `kubectl kustomize infra/k8s/base` render check                              |

### Container Publishing

`.github/workflows/container-publish.yml` builds and pushes backend images to GitHub Container
Registry.

Triggers: manual `workflow_dispatch` or semver tags such as `v0.1.0`.

Published images:

```text
ghcr.io/<owner>/knoviq-auth-service:<tag>
ghcr.io/<owner>/knoviq-ai-gateway:<tag>
ghcr.io/<owner>/knoviq-knowledge-service:<tag>
ghcr.io/<owner>/knoviq-tool-execution-service:<tag>
```

Each image is tagged with both the git tag and a `sha-...` digest tag for traceability.

The web image is built locally through `pnpm docker:build:web` and Docker Compose, but it is not
currently published by the GHCR workflow.

### Cluster Deployment

The publish workflow pushes images only. Cluster deployment is intentionally separate because it
requires environment-specific credentials, approval gates, and secret management. Implement it as a
protected GitHub Environment with required reviewers once the target cluster is ready.

---

## Smoke Test

Verify the full invoice agent pipeline end-to-end without mocking:

```bash
pnpm smoke:invoice
```

This command builds the repo, applies migrations, starts all four backend services, uploads a sample
invoice document, sends a chat request, and asserts that the agent correctly retrieves, extracts,
calculates, and validates the invoice total. Redis, Kafka, and OpenTelemetry are disabled so only a
local PostgreSQL is required.
