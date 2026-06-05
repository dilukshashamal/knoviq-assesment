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
  WalletCards,
} from "lucide-react";

import { buildMonitorSummary, type ObservabilityResponse } from "@/lib/observability";
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

export default function MonitoringPage() {
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [observability, setObservability] = useState<ObservabilityResponse | null>(null);
  const [healthChecks, setHealthChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const monitor = useMemo(() => buildMonitorSummary(observability), [observability]);
  const canView = isAdminRole(session?.user.role);
  const allServicesReady = healthChecks.length > 0 && healthChecks.every((check) => check.ok);

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
              label="Needs review"
              value={`${monitor.unsupportedRate}%`}
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

            <section className="admin-panel">
              <div className="monitor-header">
                <div>
                  <p className="eyebrow">Quality</p>
                  <h2>Answer review</h2>
                </div>
                <StatusDot ok={monitor.unsupportedRate === 0} />
              </div>
              <div className="monitor-section compact">
                {monitor.validationRows.length === 0 ? (
                  <p className="muted-copy">No checked answers yet.</p>
                ) : (
                  monitor.validationRows.map((row) => (
                    <div className="metric-row" key={row.status}>
                      <span>{formatValidationStatus(row.status)}</span>
                      <strong>{formatNumber(row.count)}</strong>
                    </div>
                  ))
                )}
              </div>
            </section>

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
                      <strong>{row.costUsd > 0 ? `$${row.costUsd.toFixed(4)}` : "—"}</strong>
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
  switch (value) {
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

function titleCase(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
