import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { AuthRole } from "@knoviq/auth";
import { hasMinimumRole } from "@knoviq/auth";
import type { ServiceConfig } from "@knoviq/config";
import { HealthResponseSchema } from "@knoviq/contracts";
import type { Pool } from "@knoviq/database";
import { createRequestId, registerFastifyObservability } from "@knoviq/observability";

import { AuthService } from "./auth-service.js";
import type { AuthSettings } from "./config.js";
import { forbidden, handleApiError, unauthorized } from "./errors.js";
import { parseBearerToken, verifyAccessToken } from "./jwt.js";
import { AuthRepository } from "./repository.js";
import { registerAuthRoutes } from "./routes.js";

export interface BuildAuthAppInput {
  config: ServiceConfig;
  pool: Pool;
  settings: AuthSettings;
  version: string;
}

export async function buildAuthApp(input: BuildAuthAppInput) {
  const serviceName = input.config.serviceName;
  const app = Fastify({
    genReqId: () => createRequestId(serviceName),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });
  const repository = new AuthRepository(input.pool);
  const authService = new AuthService(repository, input.settings);

  app.setErrorHandler(handleApiError);
  await app.register(rateLimit, {
    // Global default: 200 requests per minute per IP
    max: 200,
    timeWindow: "1 minute",
    errorResponseBuilder: (_request, context) => ({
      code: "rate_limit_exceeded",
      message: `Too many requests. Retry after ${String(context.after)}.`,
    }),
  });
  registerFastifyObservability({
    app,
    pool: input.pool,
    serviceName,
  });

  app.decorate("authenticate", async (request) => {
    const token = parseBearerToken(request.headers.authorization);
    request.principal = await verifyAccessToken(token, input.settings);
  });

  app.decorate("requireRole", (requiredRole: AuthRole) => {
    return async (request, reply) => {
      await app.authenticate(request, reply);

      if (!request.principal) {
        throw unauthorized();
      }

      if (!hasMinimumRole(request.principal.role, requiredRole)) {
        throw forbidden(`Requires ${requiredRole} role`);
      }
    };
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

  registerAuthRoutes(app, authService);

  return app;
}
