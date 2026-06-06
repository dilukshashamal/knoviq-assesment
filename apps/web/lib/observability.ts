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
  answer_quality_incidents?: ToolExecutionResponse;
  answer_quality_trend?: ToolExecutionResponse;
  answer_validation_summary?: ToolExecutionResponse;
  llm_usage_summary?: ToolExecutionResponse;
  recent_tool_executions?: ToolExecutionResponse;
  service_metric_summary?: ToolExecutionResponse;
  tool_execution_summary?: ToolExecutionResponse;
}

export interface QualityTraceToolCall {
  arguments: unknown;
  error?:
    | {
        code?: string;
        message?: string;
      }
    | undefined;
  latencyMs?: number;
  output?: unknown;
  reason?: string;
  status: string;
  toolName: string;
}

export interface QualityIncident {
  answer: string;
  conversationId: string;
  conversationTitle: string;
  createdAt: string;
  draftAnswer: string;
  failedToolCount: number;
  id: string;
  issues: string[];
  messageId: string;
  modelDeployment: string;
  requiredCaveats: string[];
  retrievalCount: number;
  retrievalQueries: string[];
  retrievalResultCount: number;
  reviewPriority: string;
  status: string;
  supportedToolNames: string[];
  tokenCount: number;
  toolCallCount: number;
  trace: {
    draftAnswer: string;
    toolCalls: QualityTraceToolCall[];
    validation: Record<string, unknown>;
  };
  userLabel: string;
  userQuestion: string;
  validationConfidence: number;
}

export interface QualityTrendBucket {
  bucket: string;
  grounded: number;
  partiallyGrounded: number;
  totalCount: number;
  unsupported: number;
  unsupportedRate: number;
}

export function buildMonitorSummary(data: ObservabilityResponse | null) {
  const qualityIncidentRowsRaw = data?.answer_quality_incidents?.output?.rows ?? [];
  const qualityTrendRowsRaw = data?.answer_quality_trend?.output?.rows ?? [];
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
  // These match the values set in .env - used to compute cost client-side
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
    totalCostUsd > 0 ? `$${llmCostUsd}` : llmRequests > 0 ? "Pricing not set" : "-";

  const toolFailures = toolRowsRaw
    .filter((row) => asString(row.status) === "failed")
    .reduce((sum, row) => sum + asNumber(row.count), 0);
  const validationCount = validationRowsRaw.reduce((sum, row) => sum + asNumber(row.count), 0);
  const unsupportedCount = validationRowsRaw
    .filter((row) => asString(row.validation_status) === "unsupported")
    .reduce((sum, row) => sum + asNumber(row.count), 0);
  const unsupportedRate =
    validationCount === 0 ? 0 : Math.round((unsupportedCount / validationCount) * 100);
  const qualityIncidents = qualityIncidentRowsRaw.map((row) => {
    const trace = asQualityTrace(row.trace);

    return {
      answer: asString(row.answer),
      conversationId: asString(row.conversation_id),
      conversationTitle: asString(row.conversation_title) || "Untitled conversation",
      createdAt: asString(row.created_at),
      draftAnswer: asString(row.draft_answer),
      failedToolCount: asNumber(row.failed_tool_count),
      id: asString(row.message_id),
      issues: asStringArray(row.validation_issues),
      messageId: asString(row.message_id),
      modelDeployment: asString(row.model_deployment),
      requiredCaveats: asStringArray(row.required_caveats),
      retrievalCount: asNumber(row.retrieval_count),
      retrievalQueries: asStringArray(row.retrieval_queries),
      retrievalResultCount: asNumber(row.retrieval_result_count),
      reviewPriority: asString(row.review_priority) || "low",
      status: asString(row.validation_status),
      supportedToolNames: asStringArray(row.supported_tool_names),
      tokenCount: asNumber(row.token_count),
      toolCallCount: asNumber(row.tool_call_count),
      trace,
      userLabel: asString(row.user_name) || asString(row.user_email) || "User",
      userQuestion: asString(row.user_question),
      validationConfidence: resolveQualityIncidentConfidence(row, trace),
    };
  });
  const qualityTrend = buildQualityTrend(qualityTrendRowsRaw);
  const highPriorityReviewCount = qualityIncidents.filter(
    (incident) => incident.reviewPriority === "high",
  ).length;
  const retrievalMissCount = qualityIncidents.filter(
    (incident) => incident.retrievalCount > 0 && incident.retrievalResultCount === 0,
  ).length;
  const failedToolIncidentCount = qualityIncidents.filter(
    (incident) => incident.failedToolCount > 0,
  ).length;

  return {
    averageLatencyMs,
    failedToolIncidentCount,
    highPriorityReviewCount,
    llmCostDisplay,
    llmCostUsd,
    llmRequests,
    maxLatencyMs,
    qualityIncidents,
    qualityTrend,
    recentTools: recentToolRowsRaw.slice(0, 8).map((row) => ({
      completedAt: asString(row.completed_at),
      createdAt: asString(row.created_at),
      errorCode: asString(row.error_code),
      latencyMs: asNumber(row.latency_ms),
      status: asString(row.status),
      toolName: asString(row.tool_name),
    })),
    requestCount,
    retrievalMissCount,
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

function buildQualityTrend(rows: Record<string, unknown>[]): QualityTrendBucket[] {
  const grouped = new Map<string, QualityTrendBucket>();

  for (const row of rows) {
    const bucket = asString(row.bucket);

    if (!bucket) {
      continue;
    }

    const existing =
      grouped.get(bucket) ??
      ({
        bucket,
        grounded: 0,
        partiallyGrounded: 0,
        totalCount: asNumber(row.total_count),
        unsupported: 0,
        unsupportedRate: asNumber(row.unsupported_rate),
      } satisfies QualityTrendBucket);
    const count = asNumber(row.count);

    switch (asString(row.validation_status)) {
      case "grounded":
        existing.grounded += count;
        break;
      case "partially_grounded":
        existing.partiallyGrounded += count;
        break;
      case "unsupported":
        existing.unsupported += count;
        break;
    }

    existing.totalCount = Math.max(existing.totalCount, asNumber(row.total_count));
    existing.unsupportedRate = Math.max(existing.unsupportedRate, asNumber(row.unsupported_rate));
    grouped.set(bucket, existing);
  }

  return [...grouped.values()]
    .sort((left, right) => left.bucket.localeCompare(right.bucket))
    .slice(-14);
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

function asQualityTrace(value: unknown): QualityIncident["trace"] {
  const record = asRecord(value);

  return {
    draftAnswer: asString(record.draftAnswer),
    toolCalls: asRecordArray(record.toolCalls).map((toolCall) => ({
      arguments: toolCall.arguments,
      error: asOptionalError(toolCall.error),
      latencyMs: asNumber(toolCall.latencyMs),
      output: toolCall.output,
      reason: asString(toolCall.reason),
      status: asString(toolCall.status),
      toolName: asString(toolCall.toolName),
    })),
    validation: asRecord(record.validation),
  };
}

function resolveQualityIncidentConfidence(
  row: Record<string, unknown>,
  trace: QualityIncident["trace"],
): number {
  const fromRow = asNumber(row.validation_confidence);
  if (fromRow > 0) {
    return fromRow;
  }

  const fromTrace = asNumber(trace.validation.confidence);
  if (fromTrace > 0) {
    return fromTrace;
  }

  const status = asString(row.validation_status);
  const retrievalResultCount = asNumber(row.retrieval_result_count);

  if (status === "partially_grounded" || (status === "unsupported" && retrievalResultCount > 0)) {
    return 0.7;
  }

  if (status === "unsupported") {
    return 0.35;
  }

  return 0;
}

function asOptionalError(value: unknown): QualityTraceToolCall["error"] | undefined {
  const record = asRecord(value);
  const code = asString(record.code);
  const message = asString(record.message);

  if (!code && !message) {
    return undefined;
  }

  return { code, message };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(asRecord).filter((item) => Object.keys(item).length > 0);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : ""))
      .filter((item) => item.length > 0);
  }

  const singleValue = asString(value);
  return singleValue ? [singleValue] : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
