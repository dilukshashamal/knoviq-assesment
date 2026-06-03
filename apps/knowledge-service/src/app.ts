import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { CacheClient } from "@knoviq/cache";
import type { ServiceConfig } from "@knoviq/config";
import { HealthResponseSchema } from "@knoviq/contracts";
import type { Pool } from "@knoviq/database";
import type { EventPublisher } from "@knoviq/events";
import { createRequestId, registerFastifyObservability } from "@knoviq/observability";

import type { KnowledgeSettings } from "./config.js";
import { createEmbeddingProvider } from "./embedding.js";
import { handleApiError } from "./errors.js";
import { parseBearerToken, verifyAccessToken } from "./jwt.js";
import { KnowledgeRepository } from "./repository.js";
import { KnowledgeService } from "./knowledge-service.js";
import { registerKnowledgeRoutes } from "./routes.js";

export interface BuildKnowledgeAppInput {
  config: ServiceConfig;
  cache: CacheClient;
  eventPublisher: EventPublisher;
  pool: Pool;
  settings: KnowledgeSettings;
  version: string;
}

export async function buildKnowledgeApp(input: BuildKnowledgeAppInput) {
  const serviceName = input.config.serviceName;
  const app = Fastify({
    genReqId: () => createRequestId(serviceName),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });
  const repository = new KnowledgeRepository(input.pool);
  const embeddingProvider = createEmbeddingProvider(input.settings);
  const knowledgeService = new KnowledgeService(
    repository,
    embeddingProvider,
    input.settings,
    input.cache,
    input.eventPublisher,
  );

  app.setErrorHandler(handleApiError);
  registerFastifyObservability({
    app,
    pool: input.pool,
    serviceName,
  });

  await app.register(multipart, {
    limits: {
      fileSize: input.settings.maxFileBytes,
      files: 1,
      parts: 12,
    },
    throwFileSizeLimit: true,
  });

  app.decorate("authenticate", async (request) => {
    const token = parseBearerToken(request.headers.authorization);
    request.principal = await verifyAccessToken(token, input.settings);
  });

  app.get("/", async () => ({
    service: serviceName,
    status: "ready",
  }));

  app.get("/health", async () =>
    HealthResponseSchema.parse({
      service: serviceName,
      status: "ok",
      timestamp: new Date().toISOString(),
      version: input.version,
    }),
  );

  registerKnowledgeRoutes(app, knowledgeService, input.settings.maxFileBytes);

  return app;
}
