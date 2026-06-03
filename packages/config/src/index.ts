import { z } from "zod";

export const NodeEnvSchema = z.enum(["development", "test", "production"]);

const ServiceConfigSchema = z.object({
  NODE_ENV: NodeEnvSchema.default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive(),
});

export type RuntimeEnv = z.infer<typeof NodeEnvSchema>;

export interface ServiceConfig {
  env: RuntimeEnv;
  host: string;
  isProduction: boolean;
  port: number;
  serviceName: string;
}

export interface LoadServiceConfigInput {
  defaultPort: number;
  portEnv: string;
  serviceName: string;
}

export function loadServiceConfig(input: LoadServiceConfigInput): ServiceConfig {
  const parsed = ServiceConfigSchema.parse({
    NODE_ENV: process.env.NODE_ENV,
    HOST: process.env.HOST,
    PORT: process.env[input.portEnv] ?? input.defaultPort,
  });

  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    isProduction: parsed.NODE_ENV === "production",
    port: parsed.PORT,
    serviceName: input.serviceName,
  };
}

export function readRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}
