export interface ToolExecutionResponse {
  error?: {
    code: string;
    message: string;
  };
  latencyMs: number;
  output?: {
    rows?: Record<string, unknown>[];
  };
  status: "succeeded" | "failed";
  toolName: string;
}

export interface ObservabilityResponse {
  answer_validation_summary?: ToolExecutionResponse;
  llm_usage_summary?: ToolExecutionResponse;
  recent_tool_executions?: ToolExecutionResponse;
  service_metric_summary?: ToolExecutionResponse;
  tool_execution_summary?: ToolExecutionResponse;
}

export function buildMonitorSummary(data: ObservabilityResponse | null) {
  const serviceRows = data?.service_metric_summary?.output?.rows ?? [];
  const llmRows = data?.llm_usage_summary?.output?.rows ?? [];
  const toolRowsRaw = data?.tool_execution_summary?.output?.rows ?? [];
  const validationRowsRaw = data?.answer_validation_summary?.output?.rows ?? [];
  const recentToolRowsRaw = data?.recent_tool_executions?.output?.rows ?? [];

  const requestMetrics = serviceRows.filter(
    (row) => asString(row.metric_name) === "http.server.requests",
  );
  const latencyMetrics = serviceRows.filter(
    (row) => asString(row.metric_name) === "http.server.duration",
  );
  const requestCount = requestMetrics.reduce((sum, row) => sum + asNumber(row.sample_count), 0);
  const averageLatencyMs =
    latencyMetrics.length === 0
      ? 0
      : Math.round(
          latencyMetrics.reduce((sum, row) => sum + asNumber(row.average_value), 0) /
            latencyMetrics.length,
        );
  const maxLatencyMs = Math.round(
    latencyMetrics.reduce((max, row) => Math.max(max, asNumber(row.max_value)), 0),
  );
  const llmRequests = llmRows.reduce((sum, row) => sum + asNumber(row.request_count), 0);

  // Azure OpenAI pricing per 1k tokens (June 2026 public rates).
  // These match the values set in .env — used to compute cost client-side
  // because historical DB rows may have estimated_cost_usd = 0 when the
  // pricing env vars were not configured at write time.
  const PRICING: Record<string, { prompt: number; completion: number }> = {
    "gpt-4o-mini": { prompt: 0.00015, completion: 0.0006 },
    "gpt-4o": { prompt: 0.0025, completion: 0.01 },
    "text-embedding-3-small": { prompt: 0.00002, completion: 0 },
    "text-embedding-3-large": { prompt: 0.00013, completion: 0 },
  };

  /** Returns the $/1k-token rate for a deployment name, falling back to gpt-4o-mini */
  function ratesFor(deployment: string) {
    const lower = deployment.toLowerCase();
    for (const [key, rates] of Object.entries(PRICING)) {
      if (lower.includes(key)) return rates;
    }
    // Default: use gpt-4o-mini rates as a conservative estimate
    return PRICING["gpt-4o-mini"]!;
  }

  const usageRows = llmRows.map((row) => {
    const promptTokens = asNumber(row.prompt_tokens);
    const completionTokens = asNumber(row.completion_tokens);
    const totalTokens = asNumber(row.total_tokens) || promptTokens + completionTokens;
    const deployment = asString(row.model_deployment);
    const rates = ratesFor(deployment);

    // Use DB cost when non-zero (it was computed at write time with correct config).
    // Fall back to client-side calculation when DB cost is zero (legacy rows).
    const dbCost = asNumber(row.estimated_cost_usd);
    const computedCost =
      (promptTokens / 1000) * rates.prompt + (completionTokens / 1000) * rates.completion;
    const costUsd = dbCost > 0 ? dbCost : computedCost;

    return {
      completionTokens,
      costUsd,
      modelDeployment: deployment,
      promptTokens,
      purpose: asString(row.purpose),
      requestCount: asNumber(row.request_count),
      totalTokens,
    };
  });

  const totalCostUsd = usageRows.reduce((sum, row) => sum + row.costUsd, 0);
  const llmCostUsd = totalCostUsd.toFixed(4);
  const llmCostDisplay =
    totalCostUsd > 0 ? `$${llmCostUsd}` : llmRequests > 0 ? "Pricing not set" : "—";

  const toolFailures = toolRowsRaw
    .filter((row) => asString(row.status) === "failed")
    .reduce((sum, row) => sum + asNumber(row.count), 0);
  const validationCount = validationRowsRaw.reduce((sum, row) => sum + asNumber(row.count), 0);
  const unsupportedCount = validationRowsRaw
    .filter((row) => asString(row.validation_status) === "unsupported")
    .reduce((sum, row) => sum + asNumber(row.count), 0);
  const unsupportedRate =
    validationCount === 0 ? 0 : Math.round((unsupportedCount / validationCount) * 100);

  return {
    averageLatencyMs,
    llmCostDisplay,
    llmCostUsd,
    llmRequests,
    maxLatencyMs,
    recentTools: recentToolRowsRaw.slice(0, 8).map((row) => ({
      completedAt: asString(row.completed_at),
      createdAt: asString(row.created_at),
      errorCode: asString(row.error_code),
      latencyMs: asNumber(row.latency_ms),
      status: asString(row.status),
      toolName: asString(row.tool_name),
    })),
    requestCount,
    serviceLatency: groupServiceLatency(latencyMetrics),
    toolFailures,
    toolRows: toolRowsRaw.slice(0, 10).map((row) => ({
      averageLatencyMs: asNumber(row.average_latency_ms),
      count: asNumber(row.count),
      status: asString(row.status),
      toolName: asString(row.tool_name),
    })),
    unsupportedCount,
    unsupportedRate,
    validationCount,
    validationRows: validationRowsRaw.map((row) => ({
      averageConfidence: asNumber(row.average_confidence),
      count: asNumber(row.count),
      status: asString(row.validation_status),
    })),
    usageRows,
  };
}

function groupServiceLatency(latencyMetrics: Record<string, unknown>[]) {
  const grouped = new Map<
    string,
    {
      max: number;
      sampleCount: number;
      sum: number;
      count: number;
      service: string;
      metric: string;
    }
  >();

  for (const row of latencyMetrics) {
    const service = asString(row.service_name);
    const metric = asString(row.metric_name);
    const key = `${service}||${metric}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.max = Math.max(existing.max, asNumber(row.max_value));
      existing.sampleCount += asNumber(row.sample_count);
      existing.sum += asNumber(row.average_value);
      existing.count += 1;
    } else {
      grouped.set(key, {
        count: 1,
        max: asNumber(row.max_value),
        metric,
        sampleCount: asNumber(row.sample_count),
        service,
        sum: asNumber(row.average_value),
      });
    }
  }

  return [...grouped.values()].slice(0, 8).map((entry) => ({
    average: Math.round(entry.sum / entry.count),
    max: Math.round(entry.max),
    metric: entry.metric,
    sampleCount: entry.sampleCount,
    service: entry.service,
  }));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
