import { jwtVerify } from "jose";
import { z } from "zod";
import type { AuthPrincipal, AuthRole } from "@knoviq/auth";

import type { AiGatewaySettings } from "./config.js";
import { unauthorized } from "./errors.js";

const JwtPayloadSchema = z.object({
  email: z.string().email(),
  jti: z.string().uuid(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
  sub: z.string().uuid(),
  tenant_id: z.string().uuid(),
});

export interface VerifiedAccessToken extends AuthPrincipal {
  email: string;
  jti: string;
  role: AuthRole;
}

function getSigningSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function parseBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw unauthorized("Missing Authorization header");
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw unauthorized("Authorization header must use Bearer token format");
  }

  return token;
}

export async function verifyAccessToken(
  token: string,
  settings: AiGatewaySettings,
): Promise<VerifiedAccessToken> {
  try {
    const verified = await jwtVerify(token, getSigningSecret(settings.jwtAccessSecret), {
      audience: settings.jwtAudience,
      issuer: settings.jwtIssuer,
    });
    const payload = JwtPayloadSchema.parse(verified.payload);

    return {
      email: payload.email,
      jti: payload.jti,
      role: payload.role,
      tenantId: payload.tenant_id,
      userId: payload.sub,
    };
  } catch {
    throw unauthorized("Invalid or expired access token");
  }
}
