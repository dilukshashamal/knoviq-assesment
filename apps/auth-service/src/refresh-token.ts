import { createHmac, randomBytes } from "node:crypto";

export function createOpaqueRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(refreshToken: string, secret: string): string {
  return createHmac("sha256", secret).update(refreshToken).digest("hex");
}

export function getRefreshTokenExpiry(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}
