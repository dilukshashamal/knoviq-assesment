# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-bookworm-slim
FROM node:${NODE_VERSION} AS build

WORKDIR /workspace

ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PNPM_STORE_DIR=/pnpm/store
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir "${PNPM_STORE_DIR}"

RUN pnpm --filter "@knoviq/web..." build

FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /workspace/apps/web/public ./apps/web/public

USER node

CMD ["node", "apps/web/server.js"]
