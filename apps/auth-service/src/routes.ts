import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthService } from "./auth-service.js";
import {
  AddTenantMemberRequestSchema,
  LoginRequestSchema,
  LogoutRequestSchema,
  RefreshTokenRequestSchema,
  RegisterRequestSchema,
  TenantMemberParamsSchema,
  UpdateTenantMemberRoleRequestSchema,
} from "./schemas.js";
import type { RequestMetadata } from "./types.js";
import { unauthorized } from "./errors.js";

function getRequestMetadata(request: FastifyRequest): RequestMetadata {
  const userAgentHeader = request.headers["user-agent"];

  return {
    ipAddress: request.ip,
    userAgent: typeof userAgentHeader === "string" ? userAgentHeader : undefined,
  };
}

export function registerAuthRoutes(app: FastifyInstance, authService: AuthService) {
  app.post("/auth/register", async (request, reply) => {
    const body = RegisterRequestSchema.parse(request.body);
    const response = await authService.register(body, getRequestMetadata(request));
    return reply.status(201).send(response);
  });

  app.post("/auth/login", async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body);
    const response = await authService.login(body, getRequestMetadata(request));
    return reply.send(response);
  });

  app.post("/auth/refresh", async (request, reply) => {
    const body = RefreshTokenRequestSchema.parse(request.body);
    const response = await authService.refresh(body.refreshToken, getRequestMetadata(request));
    return reply.send(response);
  });

  app.post("/auth/logout", async (request, reply) => {
    const body = LogoutRequestSchema.parse(request.body);
    await authService.logout(body.refreshToken);
    return reply.status(204).send();
  });

  app.get("/auth/me", { preHandler: app.authenticate }, async (request) => {
    if (!request.principal) {
      throw unauthorized();
    }

    return authService.getCurrentUser(request.principal);
  });

  app.get("/tenants", { preHandler: app.authenticate }, async (request) => {
    const principal = requirePrincipal(request);
    const tenants = await authService.listTenants(principal);

    return { tenants };
  });

  app.get("/tenants/current/members", { preHandler: app.authenticate }, async (request) => {
    const principal = requirePrincipal(request);
    const members = await authService.listTenantMembers(principal);

    return { members };
  });

  app.post("/tenants/current/members", { preHandler: app.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = AddTenantMemberRequestSchema.parse(request.body);
    const member = await authService.addTenantMember(principal, body);

    return reply.status(201).send({ member });
  });

  app.patch(
    "/tenants/current/members/:userId",
    { preHandler: app.authenticate },
    async (request) => {
      const principal = requirePrincipal(request);
      const params = TenantMemberParamsSchema.parse(request.params);
      const body = UpdateTenantMemberRoleRequestSchema.parse(request.body);
      const member = await authService.updateTenantMemberRole(principal, params.userId, body);

      return { member };
    },
  );

  app.delete(
    "/tenants/current/members/:userId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const params = TenantMemberParamsSchema.parse(request.params);

      await authService.removeTenantMember(principal, params.userId);

      return reply.status(204).send();
    },
  );
}

function requirePrincipal(request: FastifyRequest) {
  if (!request.principal) {
    throw unauthorized();
  }

  return request.principal;
}
