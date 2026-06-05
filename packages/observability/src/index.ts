import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { SpanStatusCode, trace, type Span, type SpanOptions } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { Pool } from "@knoviq/database";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface Timer {
  stop: () => number;
}

export interface ServiceMetricInput {
  labels?: Record<string, unknown>;
  metricKind: "counter" | "gauge" | "histogram";
  metricName: string;
  serviceName: string;
  tenantId?: string;
  unit?: string;
  value: number;
}

export interface RequestMetricInput {
  latencyMs: number;
  method: string;
  route: string;
  serviceName: string;
  statusCode: number;
  tenantId?: string;
}

export interface LlmCostInput {
  completionTokens: number;
  modelDeployment: string;
  promptTokens: number;
}

export interface LlmCostSettings {
  completionCostPer1kTokens: number;
  promptCostPer1kTokens: number;
}

export interface SpanInput<T> {
  attributes?: Record<string, boolean | number | string | undefined>;
  name: string;
  options?: SpanOptions;
  operation: (span: Span) => Promise<T>;
}

export interface OpenTelemetrySettings {
  enabled: boolean;
  serviceName: string;
  traceExporterUrl?: string | undefined;
}

const requestTimers = new WeakMap<FastifyRequest, Timer>();
const requestSpans = new WeakMap<FastifyRequest, Span>();
let nodeSdk: NodeSDK | undefined;

export function createTimer(): Timer {
  const startedAt = performance.now();

  return {
    stop: () => Math.round(performance.now() - startedAt),
  };
}

export function createRequestId(prefix = "req"): string {
  return `${prefix}_${randomUUID()}`;
}

export function startOpenTelemetry(settings: OpenTelemetrySettings): void {
  if (!settings.enabled || nodeSdk) {
    return;
  }

  nodeSdk = new NodeSDK({
    resource: new Resource({
      "service.name": settings.serviceName,
    }),
    traceExporter: new OTLPTraceExporter(
      settings.traceExporterUrl === undefined ? {} : { url: settings.traceExporterUrl },
    ),
  });

  nodeSdk.start();
}

export async function shutdownOpenTelemetry(): Promise<void> {
  if (!nodeSdk) {
    return;
  }

  await nodeSdk.shutdown();
  nodeSdk = undefined;
}

export function registerFastifyObservability(input: {
  app: FastifyInstance;
  pool: Pool;
  serviceName: string;
}): void {
  const tracer = trace.getTracer(input.serviceName);

  input.app.addHook("onRequest", async (request) => {
    requestTimers.set(request, createTimer());
    requestSpans.set(
      request,
      tracer.startSpan(`${request.method} ${normalizeRoute(request)}`, {
        attributes: {
          "http.request.method": request.method,
          "http.route": normalizeRoute(request),
          "knoviq.request_id": request.id,
          "service.name": input.serviceName,
        },
      }),
    );
  });

  input.app.addHook("onResponse", async (request, reply) => {
    const latencyMs = requestTimers.get(request)?.stop() ?? 0;
    const route = normalizeRoute(request);
    const tenantId = getTenantId(request);
    const span = requestSpans.get(request);

    span?.setAttributes({
      "http.response.status_code": reply.statusCode,
      "knoviq.tenant_id": tenantId ?? "unknown",
      "knoviq.latency_ms": latencyMs,
    });

    if (reply.statusCode >= 500) {
      span?.setStatus({ code: SpanStatusCode.ERROR });
    } else {
      span?.setStatus({ code: SpanStatusCode.OK });
    }

    span?.end();

    try {
      const requestMetricInput = {
        latencyMs,
        method: request.method,
        route,
        serviceName: input.serviceName,
        statusCode: reply.statusCode,
      };
      await recordRequestMetrics(
        input.pool,
        tenantId === undefined ? requestMetricInput : { ...requestMetricInput, tenantId },
      );
    } catch (error) {
      request.log.warn({ err: error }, "failed to record request metrics");
    }
  });

  input.app.addHook("onError", async (request, _reply, error) => {
    const span = requestSpans.get(request);
    span?.recordException(error);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  });
}

export async function recordServiceMetric(pool: Pool, input: ServiceMetricInput): Promise<void> {
  await pool.query(
    `
      INSERT INTO knoviq.service_metrics (
        tenant_id,
        service_name,
        metric_name,
        metric_kind,
        value,
        unit,
        labels
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      input.tenantId ?? null,
      input.serviceName,
      input.metricName,
      input.metricKind,
      input.value,
      input.unit ?? null,
      JSON.stringify(input.labels ?? {}),
    ],
  );
}

export async function recordRequestMetrics(pool: Pool, input: RequestMetricInput): Promise<void> {
  const labels = {
    method: input.method,
    route: input.route,
    statusCode: input.statusCode,
  };

  await Promise.all([
    recordServiceMetric(
      pool,
      input.tenantId === undefined
        ? {
            labels,
            metricKind: "counter",
            metricName: "http.server.requests",
            serviceName: input.serviceName,
            unit: "request",
            value: 1,
          }
        : {
            labels,
            metricKind: "counter",
            metricName: "http.server.requests",
            serviceName: input.serviceName,
            tenantId: input.tenantId,
            unit: "request",
            value: 1,
          },
    ),
    recordServiceMetric(
      pool,
      input.tenantId === undefined
        ? {
            labels,
            metricKind: "histogram",
            metricName: "http.server.duration",
            serviceName: input.serviceName,
            unit: "ms",
            value: input.latencyMs,
          }
        : {
            labels,
            metricKind: "histogram",
            metricName: "http.server.duration",
            serviceName: input.serviceName,
            tenantId: input.tenantId,
            unit: "ms",
            value: input.latencyMs,
          },
    ),
  ]);
}

/**
 * Per-model Azure OpenAI pricing (USD per 1k tokens, June 2026 public rates).
 * Matched by substring against the deployment name — covers common naming conventions
 * like "gpt-4o-mini", "my-gpt4omini-deployment", etc.
 *
 * Update these when Azure adjusts pricing or when you add new deployments.
 * Source: https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/
 */
const MODEL_PRICING: Array<{
  match: string;
  promptPer1k: number;
  completionPer1k: number;
}> = [
  // gpt-4o-mini — fast/cheap model used for planning, validation, reranking
  { match: "gpt-4o-mini", promptPer1k: 0.00015, completionPer1k: 0.0006 },
  // gpt-4o — reasoning model used for answer synthesis
  { match: "gpt-4o", promptPer1k: 0.0025, completionPer1k: 0.01 },
  // text-embedding-3-small — embedding model (completion is always 0)
  { match: "text-embedding-3-small", promptPer1k: 0.00002, completionPer1k: 0 },
  // text-embedding-3-large
  { match: "text-embedding-3-large", promptPer1k: 0.00013, completionPer1k: 0 },
  // text-embedding-ada-002 (legacy)
  { match: "text-embedding-ada", promptPer1k: 0.0001, completionPer1k: 0 },
];

export function estimateLlmCostUsd(
  input: LlmCostInput,
  settings: LlmCostSettings,
): number | undefined {
  // Resolve model-specific rates first; fall back to globally configured rates.
  // This ensures gpt-4o synthesis calls are priced correctly even when the
  // global env var is set to the cheaper gpt-4o-mini rate.
  const deployment = input.modelDeployment.toLowerCase();
  const modelRates = MODEL_PRICING.find((p) => deployment.includes(p.match));

  const promptRate = modelRates?.promptPer1k ?? settings.promptCostPer1kTokens;
  const completionRate = modelRates?.completionPer1k ?? settings.completionCostPer1kTokens;

  // If both rates are zero (not configured and no model match), skip cost recording
  if (promptRate <= 0 && completionRate <= 0) {
    return undefined;
  }

  const promptCost = (input.promptTokens / 1000) * promptRate;
  const completionCost = (input.completionTokens / 1000) * completionRate;
  return Number((promptCost + completionCost).toFixed(8));
}

export async function runWithSpan<T>(input: SpanInput<T>): Promise<T> {
  const tracer = trace.getTracer("knoviq");

  return tracer.startActiveSpan(input.name, input.options ?? {}, async (span) => {
    try {
      for (const [key, value] of Object.entries(input.attributes ?? {})) {
        if (value !== undefined) {
          span.setAttribute(key, value);
        }
      }

      const result = await input.operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

function normalizeRoute(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.url.split("?")[0] ?? request.url;
}

function getTenantId(request: FastifyRequest): string | undefined {
  const principal = (request as { principal?: { tenantId?: string } }).principal;
  return principal?.tenantId;
}
