import type { FastifyInstance, FastifyRequest } from "fastify";

import { unauthorized } from "./errors.js";
import type { ToolExecutionService } from "./tool-execution-service.js";

export function registerToolRoutes(
  app: FastifyInstance,
  toolExecutionService: ToolExecutionService,
) {
  app.get("/tools", { preHandler: app.authenticate }, async () => ({
    tools: toolExecutionService.getToolDefinitions(),
  }));

  app.post("/tools/execute", { preHandler: app.authenticate }, async (request) => {
    const principal = requirePrincipal(request);

    if (!request.accessToken) {
      throw unauthorized();
    }

    return toolExecutionService.executeTool(request.body, {
      accessToken: request.accessToken,
      requestId: request.id,
      tenantId: principal.tenantId,
      userId: principal.userId,
    });
  });
}

function requirePrincipal(request: FastifyRequest) {
  if (!request.principal) {
    throw unauthorized();
  }

  return request.principal;
}
