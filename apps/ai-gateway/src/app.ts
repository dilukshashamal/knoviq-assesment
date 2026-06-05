import Fastify from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import type { CacheClient } from "@knoviq/cache";
import type { ServiceConfig } from "@knoviq/config";
import { HealthResponseSchema } from "@knoviq/contracts";
import type { Pool } from "@knoviq/database";
import type { EventPublisher } from "@knoviq/events";
import { createRequestId, registerFastifyObservability } from "@knoviq/observability";

import { AgentRunner } from "./agent-runner.js";
import type { AiGatewaySettings } from "./config.js";
import { createAgentModel } from "./model.js";
import { handleApiError } from "./errors.js";
import { parseBearerToken, verifyAccessToken } from "./jwt.js";
import { AiGatewayRepository } from "./repository.js";
import { registerChatRoutes } from "./routes.js";
import { ToolExecutionClient } from "./tool-client.js";

export interface BuildAiGatewayAppInput {
  cache: CacheClient;
  config: ServiceConfig;
  eventPublisher: EventPublisher;
  pool: Pool;
  settings: AiGatewaySettings;
  version: string;
}

export async function buildAiGatewayApp(input: BuildAiGatewayAppInput) {
  const serviceName = input.config.serviceName;
  const app = Fastify({
    genReqId: () => createRequestId(serviceName),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });
  const repository = new AiGatewayRepository(input.pool);
  const model = createAgentModel(input.settings);
  const toolClient = new ToolExecutionClient(input.settings, input.cache);
  const agentRunner = new AgentRunner(
    repository,
    model,
    toolClient,
    input.settings,
    input.eventPublisher,
  );

  app.setErrorHandler(handleApiError);
  await app.register(rateLimit, {
    // Global: 120 requests per minute per IP
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: (_request, context) => ({
      code: "rate_limit_exceeded",
      message: `Too many requests. Retry after ${String(context.after)}.`,
    }),
  });
  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024,
    },
  });
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

  registerChatRoutes(app, agentRunner, input.settings);

  return app;
}
