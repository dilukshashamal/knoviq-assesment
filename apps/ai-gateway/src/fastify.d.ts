import type { FastifyReply } from "fastify";

import type { VerifiedAccessToken } from "./jwt.js";

type AuthPreHandler = (
  request: import("fastify").FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    authenticate: AuthPreHandler;
  }

  interface FastifyRequest {
    accessToken?: string;
    principal?: VerifiedAccessToken;
  }
}
