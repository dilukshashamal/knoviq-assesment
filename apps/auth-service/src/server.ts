import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

import { loadServiceConfig } from "@knoviq/config";
import { createPgPool } from "@knoviq/database";
import { createServiceLogger } from "@knoviq/logger";
import { shutdownOpenTelemetry, startOpenTelemetry } from "@knoviq/observability";

import { buildAuthApp } from "./app.js";
import { loadAuthSettings } from "./config.js";

const serviceName = "auth-service";
const version = "0.1.0";
const config = loadServiceConfig({
  defaultPort: 4001,
  portEnv: "AUTH_SERVICE_PORT",
  serviceName,
});
startOpenTelemetry({
  enabled: process.env.OTEL_TRACES_ENABLED === "true",
  serviceName,
  traceExporterUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
});
const settings = loadAuthSettings();
const logger = createServiceLogger({ serviceName });
const pool = createPgPool();
const app = await buildAuthApp({
  config,
  pool,
  settings,
  version,
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "shutting down service");
  await app.close();
  await pool.end();
  await shutdownOpenTelemetry();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

try {
  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, "service started");
} catch (error) {
  logger.error({ err: error }, "service failed to start");
  await pool.end();
  process.exit(1);
}
