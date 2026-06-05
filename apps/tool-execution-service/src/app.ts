import Fastify from "fastify";
import type { ServiceConfig } from "@knoviq/config";
import { HealthResponseSchema } from "@knoviq/contracts";
import type { Pool } from "@knoviq/database";
import type { EventPublisher } from "@knoviq/events";
import { createRequestId, registerFastifyObservability } from "@knoviq/observability";

import type { ToolSettings } from "./config.js";
import { handleApiError } from "./errors.js";
import { parseBearerToken, verifyAccessToken } from "./jwt.js";
import { ToolExecutionRepository } from "./repository.js";
import { registerToolRoutes } from "./routes.js";
import { ToolExecutionService } from "./tool-execution-service.js";
import { ToolRegistry } from "./tools/registry.js";

export interface BuildToolExecutionAppInput {
  config: ServiceConfig;
  eventPublisher: EventPublisher;
  pool: Pool;
  settings: ToolSettings;
  version: string;
}

export function buildToolExecutionApp(input: BuildToolExecutionAppInput) {
  const serviceName = input.config.serviceName;
  const app = Fastify({
    genReqId: () => createRequestId(serviceName),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });
  const repository = new ToolExecutionRepository(input.pool);
  const registry = new ToolRegistry(input.pool, input.settings);
  const toolExecutionService = new ToolExecutionService(repository, registry, input.eventPublisher);

  app.setErrorHandler(handleApiError);
  registerFastifyObservability({
    app,
    pool: input.pool,
    serviceName,
  });

  app.decorate("authenticate", async (request) => {
    const token = parseBearerToken(request.headers.authorization);
    request.accessToken = token;
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

  registerToolRoutes(app, toolExecutionService);

  // On startup, mark any executions left in 'running' state as failed.
  // These are orphaned rows from a previous process that was killed mid-execution.
  app.addHook("onReady", async () => {
    const recovered = await repository.recoverStaleExecutions();
    if (recovered > 0) {
      app.log.warn({ recovered }, "Marked stale running tool executions as failed on startup");
    }
  });

  return app;
}
