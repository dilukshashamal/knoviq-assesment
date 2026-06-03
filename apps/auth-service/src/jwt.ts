import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AuthPrincipal, AuthRole } from "@knoviq/auth";

import type { AuthSettings } from "./config.js";
import { unauthorized } from "./errors.js";

const JwtPayloadSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  email: z.string().email(),
  exp: z.number().optional(),
  iat: z.number().optional(),
  iss: z.string().optional(),
  jti: z.string().uuid(),
  role: z.enum(["owner", "admin", "member", "viewer"]),
  sub: z.string().uuid(),
  tenant_id: z.string().uuid(),
});

export interface AccessTokenSubject {
  email: string;
  role: AuthRole;
  tenantId: string;
  userId: string;
}

export interface VerifiedAccessToken extends AuthPrincipal {
  email: string;
  jti: string;
}

function getSigningSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  subject: AccessTokenSubject,
  settings: AuthSettings,
): Promise<string> {
  return new SignJWT({
    email: subject.email,
    role: subject.role,
    tenant_id: subject.tenantId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(subject.userId)
    .setIssuer(settings.issuer)
    .setAudience(settings.audience)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${settings.accessTtlSeconds}s`)
    .sign(getSigningSecret(settings.accessSecret));
}

export async function verifyAccessToken(
  token: string,
  settings: AuthSettings,
): Promise<VerifiedAccessToken> {
  try {
    const verified = await jwtVerify(token, getSigningSecret(settings.accessSecret), {
      audience: settings.audience,
      issuer: settings.issuer,
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
