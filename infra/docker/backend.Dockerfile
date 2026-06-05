# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-bookworm-slim
FROM node:${NODE_VERSION} AS build

ARG SERVICE_PACKAGE

WORKDIR /workspace

ENV CI=true
ENV PNPM_HOME=/pnpm
ENV PNPM_STORE_DIR=/pnpm/store
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable && corepack prepare pnpm@10.13.1 --activate

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir "${PNPM_STORE_DIR}" && \
  pnpm fetch --prod --frozen-lockfile --store-dir "${PNPM_STORE_DIR}"

RUN pnpm --filter "${SERVICE_PACKAGE}..." build

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm --filter "${SERVICE_PACKAGE}" deploy --prod --offline --store-dir "${PNPM_STORE_DIR}" /prod

FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY --from=build --chown=node:node /prod /app

USER node

CMD ["node", "dist/server.js"]
