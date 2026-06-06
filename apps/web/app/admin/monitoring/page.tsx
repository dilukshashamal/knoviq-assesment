"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Clock3,
  Gauge,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Trash2,
  WalletCards,
} from "lucide-react";

import {
  buildMonitorSummary,
  type ObservabilityResponse,
  type QualityIncident,
  type QualityTraceToolCall,
} from "@/lib/observability";
import { isAdminRole, readStoredSession, type AuthResponse } from "@/lib/session";

interface HealthCheck {
  key: string;
  label: string;
  latencyMs: number;
  ok: boolean;
  status: number;
}

interface ApiErrorBody {
  code?: string;
  details?: string;
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}

type MonitorSummary = ReturnType<typeof buildMonitorSummary>;

const REVIEW_ACTIONS = [
  { label: "Bad answer", value: "bad_answer" },
  { label: "Retrieval issue", value: "retrieval_issue" },
  { label: "Validator false alarm", value: "validator_false_alarm" },
  { label: "Resolved", value: "resolved" },
] as const;

export default function MonitoringPage() {
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [observability, setObservability] = useState<ObservabilityResponse | null>(null);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, string>>({});
  const [reviewDecisionsLoaded, setReviewDecisionsLoaded] = useState(false);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const monitor = useMemo(() => buildMonitorSummary(observability), [observability]);
  const canView = isAdminRole(session?.user.role);
  const allServicesReady = healthChecks.length > 0 && healthChecks.every((check) => check.ok);
  const reviewStorageKey = session ? `knoviq.qualityReviews.${session.user.tenantId}` : undefined;
  const openQualityIncidents = useMemo(
    () =>
      monitor.qualityIncidents.filter((incident) => reviewDecisions[incident.id] !== "resolved"),
    [monitor.qualityIncidents, reviewDecisions],
  );
  const selectedIncident = useMemo(
    () =>
      openQualityIncidents.find((incident) => incident.id === selectedIncidentId) ??
      openQualityIncidents[0] ??
      null,
    [openQualityIncidents, selectedIncidentId],
  );

  useEffect(() => {
    const storedSession = readStoredSession();
    setSession(storedSession);

    if (!storedSession) {
      setStatus("Sign in with an owner or admin account to view the admin console.");
      setLoading(false);
      return;
    }

    if (!isAdminRole(storedSession.user.role)) {
      setStatus("The admin console is available to workspace owners and admins.");
      setLoading(false);
      return;
    }

    void refresh(storedSession.tokens.accessToken);
  }, []);

  useEffect(() => {
    if (!reviewStorageKey) {
      return;
    }

    try {
      const storedReviews = window.localStorage.getItem(reviewStorageKey);
      setReviewDecisions(
        storedReviews ? (JSON.parse(storedReviews) as Record<string, string>) : {},
      );
    } catch {
      setReviewDecisions({});
    } finally {
      setReviewDecisionsLoaded(true);
    }
  }, [reviewStorageKey]);

  useEffect(() => {
    if (!reviewStorageKey || !reviewDecisionsLoaded) {
      return;
    }

    window.localStorage.setItem(reviewStorageKey, JSON.stringify(reviewDecisions));
  }, [reviewDecisions, reviewDecisionsLoaded, reviewStorageKey]);

  async function refresh(token = session?.tokens.accessToken) {
    if (!token) {
      setStatus("Sign in with an owner or admin account to view the admin console.");
      return;
    }

    setLoading(true);
    setStatus(null);

    try {
      const [observabilityResponse, healthResponse] = await Promise.all([
        requestJson<ObservabilityResponse>("/api/observability", {
          cache: "no-store",
          headers: {
            authorization: `Bearer ${token}`,
          },
        }),
        requestJson<{ checks: HealthCheck[] }>("/api/health", {
          cache: "no-store",
        }),
      ]);

      setObservability(observabilityResponse);
      setHealthChecks(healthResponse.checks);
      setLastUpdatedAt(new Date().toISOString());
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  function markIncidentReview(incidentId: string, decision: string) {
    setReviewDecisions((current) => ({
      ...current,
      [incidentId]: decision,
    }));
  }

  return (
    <main className="admin-shell">
      <header className="admin-topbar">
        <Link className="secondary-button" href="/">
          <ArrowLeft className="h-4 w-4" />
          Back to chat
        </Link>
        <button
          className="mini-icon-button"
          disabled={!canView || loading}
          onClick={() => void refresh()}
          title="Refresh admin console"
          type="button"
        >
          <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </button>
      </header>

      <section className="admin-hero">
        <div>
          <p className="eyebrow">Admin console</p>
          <h1>Workspace health</h1>
          <p>
            A production view for owners and admins: service readiness, answer quality, usage, cost,
            and background job health.
          </p>
        </div>
        <div className={allServicesReady ? "service-pill ok" : "service-pill"}>
          {loading ? "Refreshing" : allServicesReady ? "Core services ready" : "Needs attention"}
        </div>
      </section>

      {status ? (
        <section className="admin-alert">
          <TriangleAlert className="h-4 w-4" />
          <span>{status}</span>
        </section>
      ) : null}

      {!canView ? (
        <section className="admin-locked-panel">
          <ShieldCheck className="h-5 w-5" />
          <div>
            <h2>Admin access required</h2>
            <p>Return to chat and sign in with a workspace owner or admin account.</p>
          </div>
        </section>
      ) : (
        <>
          <section className="metric-grid admin-metric-grid">
            <MetricTile
              icon={<ShieldCheck className="h-4 w-4" />}
              label="Answers checked"
              value={formatNumber(monitor.validationCount)}
            />
            <MetricTile
              icon={<TriangleAlert className="h-4 w-4" />}
              label="Review queue"
              value={formatNumber(openQualityIncidents.length)}
            />
            <MetricTile
              icon={<Clock3 className="h-4 w-4" />}
              label="Avg response"
              value={formatLatency(monitor.averageLatencyMs)}
            />
            <MetricTile
              icon={<WalletCards className="h-4 w-4" />}
              label="AI spend"
              value={monitor.llmCostDisplay}
            />
            <MetricTile
              icon={<Sparkles className="h-4 w-4" />}
              label="AI requests"
              value={formatNumber(monitor.llmRequests)}
            />
            <MetricTile
              icon={<Activity className="h-4 w-4" />}
              label="Workspace requests"
              value={formatNumber(monitor.requestCount)}
            />
            <MetricTile
              icon={<Gauge className="h-4 w-4" />}
              label="Peak response"
              value={formatLatency(monitor.maxLatencyMs)}
            />
            <MetricTile
              icon={<TriangleAlert className="h-4 w-4" />}
              label="Failed jobs"
              value={formatNumber(monitor.toolFailures)}
            />
          </section>

          <div className="admin-grid">
            <section className="admin-panel">
              <div className="monitor-header">
                <div>
                  <p className="eyebrow">Readiness</p>
                  <h2>Core services</h2>
                </div>
                <StatusDot ok={allServicesReady} />
              </div>
              <div className="monitor-section compact">
                {healthChecks.length === 0 ? (
                  <p className="muted-copy">No service checks yet.</p>
                ) : (
                  healthChecks.map((check) => (
                    <div className="metric-row" key={check.key}>
                      <span>{formatServiceName(check.label)}</span>
                      <strong>{check.ok ? "Ready" : "Unavailable"}</strong>
                    </div>
                  ))
                )}
              </div>
            </section>

            <QualityPulsePanel monitor={monitor} />

            <QualityReviewPanel
              incidents={openQualityIncidents}
              openCount={openQualityIncidents.length}
              reviewDecisions={reviewDecisions}
              selectedIncident={selectedIncident}
              onDelete={(incidentId) => markIncidentReview(incidentId, "resolved")}
              onDecision={markIncidentReview}
              onSelect={setSelectedIncidentId}
            />

            <section className="admin-panel wide">
              <div className="monitor-header">
                <div>
                  <p className="eyebrow">Usage</p>
                  <h2>AI work</h2>
                </div>
                {lastUpdatedAt ? (
                  <p className="status-copy">Updated {formatTime(lastUpdatedAt)}</p>
                ) : null}
              </div>
              <div className="monitor-section compact">
                {monitor.usageRows.length === 0 ? (
                  <p className="muted-copy">No AI usage recorded yet.</p>
                ) : (
                  monitor.usageRows.map((row) => (
                    <div className="metric-row" key={`${row.purpose}-${row.modelDeployment}`}>
                      <span>
                        {formatPurpose(row.purpose)}
                        <small>{formatNumber(row.totalTokens)} tokens</small>
                      </span>
                      <strong>{row.costUsd > 0 ? `$${row.costUsd.toFixed(4)}` : "-"}</strong>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="admin-panel">
              <div className="monitor-header">
                <div>
                  <p className="eyebrow">Reliability</p>
                  <h2>Background jobs</h2>
                </div>
                <StatusDot ok={monitor.toolFailures === 0} />
              </div>
              <div className="monitor-section compact">
                {monitor.toolRows.length === 0 ? (
                  <p className="muted-copy">No background jobs recorded yet.</p>
                ) : (
                  monitor.toolRows.map((row) => (
                    <div className="metric-row" key={`${row.toolName}-${row.status}`}>
                      <span>
                        {formatJobName(row.toolName)}
                        <small>{formatStatus(row.status)}</small>
                      </span>
                      <strong>{formatNumber(row.count)}</strong>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="admin-panel">
              <div className="monitor-header">
                <div>
                  <p className="eyebrow">Performance</p>
                  <h2>Service response</h2>
                </div>
              </div>
              <div className="monitor-section compact">
                {monitor.serviceLatency.length === 0 ? (
                  <p className="muted-copy">No response samples yet.</p>
                ) : (
                  monitor.serviceLatency.map((metric) => (
                    <div className="metric-row" key={`${metric.service}-${metric.metric}`}>
                      <span>
                        {formatServiceName(metric.service)}
                        <small>{formatNumber(metric.sampleCount)} samples</small>
                      </span>
                      <strong>{formatLatency(metric.average)}</strong>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="admin-panel wide">
              <div className="monitor-header">
                <div>
                  <p className="eyebrow">Recent activity</p>
                  <h2>Latest jobs</h2>
                </div>
              </div>
              <div className="monitor-section compact">
                {monitor.recentTools.length === 0 ? (
                  <p className="muted-copy">No recent jobs yet.</p>
                ) : (
                  monitor.recentTools.map((row, index) => (
                    <div className="metric-row" key={`${row.toolName}-${row.createdAt}-${index}`}>
                      <span>
                        {formatJobName(row.toolName)}
                        <small>{formatStatus(row.status)}</small>
                      </span>
                      <strong>{formatLatency(row.latencyMs)}</strong>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function QualityPulsePanel(props: { monitor: MonitorSummary }) {
  const latestTrend = props.monitor.qualityTrend.at(-1);

  return (
    <section className="admin-panel">
      <div className="monitor-header">
        <div>
          <p className="eyebrow">Quality</p>
          <h2>Answer pulse</h2>
        </div>
        <StatusDot
          ok={props.monitor.unsupportedRate === 0 && props.monitor.highPriorityReviewCount === 0}
        />
      </div>

      <div className="quality-signal-grid">
        <QualitySignal
          label="Unsupported rate"
          tone={props.monitor.unsupportedRate > 0 ? "warning" : "ok"}
          value={`${props.monitor.unsupportedRate}%`}
        />
        <QualitySignal
          label="High priority"
          tone={props.monitor.highPriorityReviewCount > 0 ? "danger" : "ok"}
          value={formatNumber(props.monitor.highPriorityReviewCount)}
        />
        <QualitySignal
          label="Retrieval misses"
          tone={props.monitor.retrievalMissCount > 0 ? "warning" : "ok"}
          value={formatNumber(props.monitor.retrievalMissCount)}
        />
        <QualitySignal
          label="Tool failures"
          tone={props.monitor.failedToolIncidentCount > 0 ? "warning" : "ok"}
          value={formatNumber(props.monitor.failedToolIncidentCount)}
        />
      </div>

      <div className="monitor-section compact">
        {props.monitor.validationRows.length === 0 ? (
          <p className="muted-copy">No checked answers yet.</p>
        ) : (
          props.monitor.validationRows.map((row) => (
            <div className="metric-row" key={row.status}>
              <span>
                {formatValidationStatus(row.status)}
                <small>{formatConfidence(row.averageConfidence)} avg confidence</small>
              </span>
              <strong>{formatNumber(row.count)}</strong>
            </div>
          ))
        )}
      </div>

      <div className="monitor-section compact">
        <div className="quality-trend-header">
          <span>30-day quality trend</span>
          <strong>{latestTrend ? `${latestTrend.unsupportedRate}%` : "-"}</strong>
        </div>
        {props.monitor.qualityTrend.length === 0 ? (
          <p className="muted-copy">No trend samples yet.</p>
        ) : (
          <div className="quality-trend-bars" aria-label="Unsupported answer rate by day">
            {props.monitor.qualityTrend.map((bucket) => (
              <div
                className={
                  bucket.unsupportedRate > 0 ? "quality-trend-bar warning" : "quality-trend-bar"
                }
                key={bucket.bucket}
                title={`${formatShortDate(bucket.bucket)}: ${bucket.unsupportedRate}% unsupported`}
              >
                <span
                  style={{
                    height: `${Math.max(4, Math.min(100, bucket.unsupportedRate))}%`,
                  }}
                />
                <small>{formatShortDate(bucket.bucket)}</small>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function QualitySignal(props: { label: string; tone: "danger" | "ok" | "warning"; value: string }) {
  return (
    <div className={`quality-signal ${props.tone}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function QualityReviewPanel(props: {
  incidents: QualityIncident[];
  onDelete: (incidentId: string) => void;
  onDecision: (incidentId: string, decision: string) => void;
  onSelect: (incidentId: string) => void;
  openCount: number;
  reviewDecisions: Record<string, string>;
  selectedIncident: QualityIncident | null;
}) {
  return (
    <section className="admin-panel wide">
      <div className="monitor-header">
        <div>
          <p className="eyebrow">Quality</p>
          <h2>Answer review inbox</h2>
          <p className="status-copy">
            Recent non-grounded answers with validation, retrieval, tool calls, and review action.
          </p>
        </div>
        <div className={props.openCount > 0 ? "review-count-pill warning" : "review-count-pill ok"}>
          {formatNumber(props.openCount)} open
        </div>
      </div>

      {props.incidents.length === 0 ? (
        <div className="review-empty">
          <ShieldCheck className="h-5 w-5" />
          <div>
            <h3>No quality incidents in the last 30 days.</h3>
            <p className="muted-copy">
              When an answer is unsupported or partly supported, it will appear here with its trace.
            </p>
          </div>
        </div>
      ) : (
        <div className="review-console">
          <div className="review-inbox" aria-label="Quality incidents">
            {props.incidents.map((incident) => {
              const decision = props.reviewDecisions[incident.id];
              const isSelected = props.selectedIncident?.id === incident.id;
              const confidenceLabel = formatConfidence(incident.validationConfidence);

              return (
                <div
                  className={isSelected ? "review-row active" : "review-row"}
                  key={incident.id}
                >
                  <button
                    className="review-row-main"
                    onClick={() => props.onSelect(incident.id)}
                    type="button"
                  >
                    <span className="review-badge-row">
                      <span className={`review-status ${getIncidentDisplayStatus(incident)}`}>
                        {formatIncidentStatus(incident)}
                      </span>
                      {confidenceLabel ? (
                        <span className="review-confidence">{confidenceLabel} confidence</span>
                      ) : null}
                    </span>
                    <strong>
                      {truncateText(
                        incident.userQuestion || incident.conversationTitle || incident.answer,
                        110,
                      )}
                    </strong>
                    <small>
                      {incident.userLabel} - {formatDateTime(incident.createdAt)} -{" "}
                      {formatNumber(incident.retrievalResultCount)} sources -{" "}
                      {decision
                        ? formatReviewDecision(decision)
                        : formatReviewPriority(incident.reviewPriority)}
                    </small>
                  </button>
                  <button
                    className="review-delete"
                    onClick={() => props.onDelete(incident.id)}
                    title="Remove from review inbox"
                    type="button"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>

          <ReviewDetail
            incident={props.selectedIncident}
            reviewDecision={
              props.selectedIncident ? props.reviewDecisions[props.selectedIncident.id] : undefined
            }
            onDecision={props.onDecision}
          />
        </div>
      )}
    </section>
  );
}

function ReviewDetail(props: {
  incident: QualityIncident | null;
  onDecision: (incidentId: string, decision: string) => void;
  reviewDecision: string | undefined;
}) {
  if (!props.incident) {
    return (
      <div className="review-detail empty">
        <p className="muted-copy">Select an incident to inspect the answer trace.</p>
      </div>
    );
  }
  const incident = props.incident;

  return (
    <div className="review-detail">
      <div className="review-detail-header">
        <div>
          <span className={`review-priority ${incident.reviewPriority}`}>
            {formatReviewPriority(incident.reviewPriority)}
          </span>
          <h3>{formatIncidentStatus(incident)}</h3>
        </div>
        {formatConfidence(incident.validationConfidence) ? (
          <span className="review-meta">{formatConfidence(incident.validationConfidence)}</span>
        ) : null}
      </div>

      <div className="review-actions" aria-label="Review decision">
        {REVIEW_ACTIONS.map((action) => (
          <button
            className={
              props.reviewDecision === action.value ? "review-action active" : "review-action"
            }
            key={action.value}
            onClick={() => props.onDecision(incident.id, action.value)}
            type="button"
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="review-detail-section">
        <p className="eyebrow">Question</p>
        <p className="review-copy">{incident.userQuestion || "Question not captured."}</p>
      </div>

      <div className="review-detail-section">
        <p className="eyebrow">Final answer</p>
        <p className="review-copy scrollable">{incident.answer}</p>
      </div>

      {incident.draftAnswer ? (
        <div className="review-detail-section">
          <p className="eyebrow">Original draft before guardrail</p>
          <p className="review-copy scrollable">{incident.draftAnswer}</p>
        </div>
      ) : null}

      <div className="review-detail-section">
        <p className="eyebrow">Validation findings</p>
        <ReviewList
          emptyLabel="No validator issues were recorded."
          items={[...incident.issues, ...incident.requiredCaveats]}
        />
      </div>

      <div className="review-detail-section">
        <p className="eyebrow">Evidence trail</p>
        {incident.trace.toolCalls.length === 0 ? (
          <p className="muted-copy">No tool calls were recorded for this answer.</p>
        ) : (
          <div className="trace-step-list">
            {incident.trace.toolCalls.map((toolCall, index) => (
              <TraceStep key={`${toolCall.toolName}-${index}`} toolCall={toolCall} />
            ))}
          </div>
        )}
      </div>

      <div className="review-detail-section compact">
        <p className="eyebrow">Production handles</p>
        <div className="review-handle-grid">
          <span>
            Message <strong>{truncateText(incident.messageId, 8)}</strong>
          </span>
          <span>
            Conversation <strong>{truncateText(incident.conversationId, 8)}</strong>
          </span>
          <span>
            Model <strong>{incident.modelDeployment || "-"}</strong>
          </span>
          <span>
            User <strong>{incident.userLabel}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}

function ReviewList(props: { emptyLabel: string; items: string[] }) {
  if (props.items.length === 0) {
    return <p className="muted-copy">{props.emptyLabel}</p>;
  }

  return (
    <ul className="review-list">
      {props.items.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

function TraceStep(props: { toolCall: QualityTraceToolCall }) {
  const argumentSummary = getToolArgumentSummary(props.toolCall);
  const outputSummary = getToolOutputSummary(props.toolCall);
  const sourcePreviews = getSourcePreviews(props.toolCall);

  return (
    <div className="trace-step">
      <div className="trace-step-header">
        <strong>{formatJobName(props.toolCall.toolName)}</strong>
        <span
          className={props.toolCall.status === "failed" ? "trace-status failed" : "trace-status"}
        >
          {formatStatus(props.toolCall.status)}
        </span>
      </div>
      {props.toolCall.reason ? <p>{props.toolCall.reason}</p> : null}
      {argumentSummary ? <small>{argumentSummary}</small> : null}
      {outputSummary ? <small>{outputSummary}</small> : null}
      {props.toolCall.latencyMs ? <small>{formatLatency(props.toolCall.latencyMs)}</small> : null}
      {props.toolCall.error ? (
        <p className="trace-error">
          {props.toolCall.error.code}: {props.toolCall.error.message}
        </p>
      ) : null}
      {sourcePreviews.length > 0 ? (
        <div className="source-preview-list">
          {sourcePreviews.map((source, index) => (
            <div className="source-preview" key={`${source.chunkId}-${index}`}>
              <strong>{source.documentTitle}</strong>
              <p>{truncateText(source.content, 220)}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MetricTile(props: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric-tile">
      {props.icon}
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function StatusDot(props: { ok: boolean }) {
  return (
    <span
      className={props.ok ? "status-dot ok" : "status-dot"}
      title={props.ok ? "Ready" : "Needs attention"}
    />
  );
}

async function requestJson<TResponse>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<TResponse> {
  const response = await fetch(input, init);
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    throw new Error(extractApiMessage(data, response.status));
  }

  return data as TResponse;
}

function extractApiMessage(data: unknown, status: number): string {
  if (isApiErrorBody(data)) {
    return (
      data.error?.message ??
      data.message ??
      data.details ??
      data.error?.code ??
      data.code ??
      `Request failed: ${status}`
    );
  }

  return `Request failed: ${status}`;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatLatency(value: number): string {
  return value > 0 ? `${formatNumber(value)}ms` : "-";
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatServiceName(value: string): string {
  const normalized = value.toLowerCase();

  if (normalized.includes("auth")) {
    return "Accounts";
  }

  if (normalized.includes("ai")) {
    return "Answers";
  }

  if (normalized.includes("knowledge")) {
    return "Documents";
  }

  if (normalized.includes("tool")) {
    return "Actions";
  }

  return titleCase(value);
}

function formatJobName(value: string): string {
  switch (value) {
    case "calculator.evaluate":
      return "Calculation";
    case "document.extract_invoice_fields":
      return "Expense extraction";
    case "knowledge.retrieve":
      return "Source lookup";
    case "sql.query_safe":
      return "Workspace report";
    default:
      return titleCase(value);
  }
}

function formatPurpose(value: string): string {
  switch (value) {
    case "answer_synthesis":
      return "Answering";
    case "embedding":
      return "Document indexing";
    case "summarization":
      return "Summaries";
    case "tool_planning":
      return "Planning";
    case "validation":
      return "Answer review";
    default:
      return titleCase(value);
  }
}

function formatStatus(value: string): string {
  switch (value) {
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "queued":
      return "Queued";
    default:
      return titleCase(value);
  }
}

function formatValidationStatus(value: string): string {
  switch (normalizeValidationStatus(value)) {
    case "grounded":
      return "Well supported";
    case "partially_grounded":
      return "Partly supported";
    case "unsupported":
      return "Needs review";
    default:
      return titleCase(value);
  }
}

function formatIncidentStatus(incident: QualityIncident): string {
  return formatValidationStatus(getIncidentDisplayStatus(incident));
}

function getIncidentDisplayStatus(incident: QualityIncident): string {
  const status = normalizeValidationStatus(incident.status);

  if (status === "unsupported" && incident.retrievalResultCount > 0) {
    return "partially_grounded";
  }

  return status;
}

function normalizeValidationStatus(value: string): string {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_").trim();

  if (
    normalized === "partially_supported" ||
    normalized === "partly_supported" ||
    normalized === "partial" ||
    normalized === "partly_grounded"
  ) {
    return "partially_grounded";
  }

  return normalized;
}

function formatConfidence(value: number): string {
  if (value <= 0) {
    return "";
  }

  return `${Math.round(value * 100)}%`;
}

function formatDateTime(value: string): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("en-US", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });
}

function formatShortDate(value: string): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "short",
  });
}

function formatReviewDecision(value: string): string {
  switch (value) {
    case "bad_answer":
      return "Bad answer";
    case "retrieval_issue":
      return "Retrieval issue";
    case "resolved":
      return "Resolved";
    case "validator_false_alarm":
      return "Validator false alarm";
    default:
      return titleCase(value);
  }
}

function formatReviewPriority(value: string): string {
  switch (value) {
    case "high":
      return "High priority";
    case "medium":
      return "Medium priority";
    case "low":
      return "Low priority";
    default:
      return titleCase(value);
  }
}

function getToolArgumentSummary(toolCall: QualityTraceToolCall): string {
  const args = asReviewRecord(toolCall.arguments);
  const query = asReviewString(args.query);
  const operation = asReviewString(args.operation);
  const expression = asReviewString(args.expression);

  if (query) {
    return `Query: ${query}`;
  }

  if (operation) {
    return `Operation: ${formatPurpose(operation)}`;
  }

  if (expression) {
    return `Expression: ${expression}`;
  }

  return "";
}

function getToolOutputSummary(toolCall: QualityTraceToolCall): string {
  const output = asReviewRecord(toolCall.output);
  const results = asReviewRecordArray(output.results);
  const rows = asReviewRecordArray(output.rows);

  if (results.length > 0) {
    return `${formatNumber(results.length)} retrieved chunks`;
  }

  if (rows.length > 0) {
    return `${formatNumber(rows.length)} rows returned`;
  }

  return "";
}

function getSourcePreviews(toolCall: QualityTraceToolCall) {
  const output = asReviewRecord(toolCall.output);

  return asReviewRecordArray(output.results)
    .slice(0, 3)
    .map((result) => ({
      chunkId: asReviewString(result.chunkId),
      content: asReviewString(result.chunkContent),
      documentTitle: asReviewString(result.documentTitle) || "Retrieved source",
    }))
    .filter((source) => source.content.length > 0);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function asReviewRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asReviewRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(asReviewRecord).filter((record) => Object.keys(record).length > 0);
}

function asReviewString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function titleCase(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
