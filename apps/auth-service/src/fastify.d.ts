import type { AuthPrincipal, AuthRole } from "@knoviq/auth";
import type { FastifyReply } from "fastify";

type AuthPreHandler = (
  request: import("fastify").FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    authenticate: AuthPreHandler;
    requireRole(requiredRole: AuthRole): AuthPreHandler;
  }

  interface FastifyRequest {
    principal?: AuthPrincipal & {
      email: string;
      jti: string;
    };
  }
}
