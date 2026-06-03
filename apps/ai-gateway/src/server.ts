import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

loadDotenv({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

import { createCacheClient, loadCacheSettings } from "@knoviq/cache";
import { loadServiceConfig } from "@knoviq/config";
import { createPgPool } from "@knoviq/database";
import { createEventPublisher, loadEventBusSettings } from "@knoviq/events";
import { createServiceLogger } from "@knoviq/logger";
import { shutdownOpenTelemetry, startOpenTelemetry } from "@knoviq/observability";

import { buildAiGatewayApp } from "./app.js";
import { loadAiGatewaySettings } from "./config.js";

const serviceName = "ai-gateway";
const version = "0.1.0";
const config = loadServiceConfig({
  defaultPort: 4002,
  portEnv: "AI_GATEWAY_PORT",
  serviceName,
});
startOpenTelemetry({
  enabled: process.env.OTEL_TRACES_ENABLED === "true",
  serviceName,
  traceExporterUrl: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
});
const settings = loadAiGatewaySettings();
const cache = createCacheClient(loadCacheSettings());
const eventPublisher = createEventPublisher(loadEventBusSettings({ serviceName }));
const logger = createServiceLogger({ serviceName });
const pool = createPgPool();
const app = await buildAiGatewayApp({
  cache,
  config,
  eventPublisher,
  pool,
  settings,
  version,
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "shutting down service");
  await app.close();
  await eventPublisher.shutdown();
  await cache.shutdown();
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
  await eventPublisher.shutdown();
  await cache.shutdown();
  await pool.end();
  process.exit(1);
}
