import pino, { type Logger } from "pino";

export interface CreateServiceLoggerInput {
  serviceName: string;
}

export function createServiceLogger(input: CreateServiceLoggerInput): Logger {
  return pino({
    base: {
      service: input.serviceName,
    },
    level: process.env.LOG_LEVEL ?? "info",
    name: input.serviceName,
    redact: {
      censor: "[redacted]",
      paths: [
        "apiKey",
        "authorization",
        "headers.authorization",
        "password",
        "refreshToken",
        "token",
      ],
    },
  });
}
