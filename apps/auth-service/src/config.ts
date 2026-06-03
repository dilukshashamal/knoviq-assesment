import { z } from "zod";

const AuthSettingsSchema = z.object({
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  JWT_ISSUER: z.string().min(1).default("knoviq-auth-service"),
  JWT_AUDIENCE: z.string().min(1).default("knoviq-api"),
});

export interface AuthSettings {
  accessSecret: string;
  accessTtlSeconds: number;
  audience: string;
  issuer: string;
  refreshSecret: string;
  refreshTtlSeconds: number;
}

export function loadAuthSettings(): AuthSettings {
  const parsed = AuthSettingsSchema.parse(process.env);

  return {
    accessSecret: parsed.JWT_ACCESS_SECRET,
    accessTtlSeconds: parsed.JWT_ACCESS_TTL_SECONDS,
    audience: parsed.JWT_AUDIENCE,
    issuer: parsed.JWT_ISSUER,
    refreshSecret: parsed.JWT_REFRESH_SECRET,
    refreshTtlSeconds: parsed.JWT_REFRESH_TTL_SECONDS,
  };
}
