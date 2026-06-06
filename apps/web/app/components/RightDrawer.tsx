"use client";

import { type ChangeEvent, type FormEvent, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Calculator,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  FileText,
  Loader2,
  Receipt,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import type { ChatMessage, DocumentSummary, ToolCall } from "../types";
import {
  extractSources,
  formatDocumentStatus,
  formatSectionCount,
  getDisplayValidation,
  truncateText,
} from "../ui-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type DrawerTab = "documents" | "inspector";

// ─────────────────────────────────────────────────────────────────────────────
// RightDrawer — top-level component with tab bar
// ─────────────────────────────────────────────────────────────────────────────

export function RightDrawer(props: {
  // Documents tab props
  accessToken: string | undefined;
  documentTitle: string;
  documents: DocumentSummary[];
  documentsLoading: boolean;
  onDelete: (document: DocumentSummary) => Promise<void>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRefresh: () => void;
  onTitleChange: (value: string) => void;
  onUpload: (event: FormEvent<HTMLFormElement>) => void;
  selectedFile: File | null;
  uploadStatus: string | null;
  // Inspector tab props
  activeMessage: ChatMessage | null;
}) {
  const [tab, setTab] = useState<DrawerTab>("documents");

  const hasInspectable =
    props.activeMessage !== null &&
    ((props.activeMessage.toolCalls?.length ?? 0) > 0 ||
      props.activeMessage.validation !== undefined);

  return (
    <div className="right-drawer-shell">
      {/* ── Tab bar ──────────────────────────────────────────────────────────── */}
      <div className="drawer-tab-bar" role="tablist" aria-label="Right panel">
        <button
          role="tab"
          type="button"
          aria-selected={tab === "documents"}
          className={tab === "documents" ? "drawer-tab active" : "drawer-tab"}
          onClick={() => setTab("documents")}
        >
          <BookOpen className="h-3.5 w-3.5" />
          Documents
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={tab === "inspector"}
          className={tab === "inspector" ? "drawer-tab active" : "drawer-tab"}
          onClick={() => setTab("inspector")}
        >
          <Activity className="h-3.5 w-3.5" />
          AI Inspector
          {/* Dot badge when there is something to inspect */}
          {hasInspectable ? <span className="drawer-tab-dot" aria-hidden="true" /> : null}
        </button>
      </div>

      {/* ── Tab panels ───────────────────────────────────────────────────────── */}
      <div className="drawer-tab-content">
        {tab === "documents" ? (
          <DocumentsTab
            accessToken={props.accessToken}
            documentTitle={props.documentTitle}
            documents={props.documents}
            documentsLoading={props.documentsLoading}
            onDelete={props.onDelete}
            onFileChange={props.onFileChange}
            onRefresh={props.onRefresh}
            onTitleChange={props.onTitleChange}
            onUpload={props.onUpload}
            selectedFile={props.selectedFile}
            uploadStatus={props.uploadStatus}
          />
        ) : (
          <InspectorTab message={props.activeMessage} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents Tab (extracted from DocumentPanel)
// ─────────────────────────────────────────────────────────────────────────────

function DocumentStatusBadge({ status }: { status: string }) {
  const label = formatDocumentStatus(status);

  if (label === "Ready") {
    return (
      <Badge variant="success" className="gap-1 px-1.5 py-0 text-[10px]">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Ready
      </Badge>
    );
  }
  if (label === "Needs attention") {
    return (
      <Badge variant="destructive" className="gap-1 px-1.5 py-0 text-[10px]">
        <AlertCircle className="h-2.5 w-2.5" />
        Error
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
      <Clock className="h-2.5 w-2.5" />
      Preparing
    </Badge>
  );
}

function DocumentsTab(props: {
  accessToken: string | undefined;
  documentTitle: string;
  documents: DocumentSummary[];
  documentsLoading: boolean;
  onDelete: (document: DocumentSummary) => Promise<void>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRefresh: () => void;
  onTitleChange: (value: string) => void;
  onUpload: (event: FormEvent<HTMLFormElement>) => void;
  selectedFile: File | null;
  uploadStatus: string | null;
}) {
  const isUploadError =
    props.uploadStatus !== null && !props.uploadStatus.toLowerCase().startsWith("uploaded");

  return (
    <div className="documents-tab">
      {/* Header */}
      <div className="drawer-header">
        <div>
          <p className="eyebrow">Documents</p>
          <h2>Sources</h2>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={!props.accessToken || props.documentsLoading}
                onClick={props.onRefresh}
                aria-label="Refresh documents"
              >
                <RefreshCw
                  className={props.documentsLoading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh document list</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Upload form */}
      <form className="source-upload" onSubmit={props.onUpload}>
        <div className="auth-field">
          <Label className="text-xs font-bold uppercase text-muted-foreground">Title</Label>
          <Input
            onChange={(e) => props.onTitleChange(e.target.value)}
            placeholder="Document title (optional)"
            value={props.documentTitle}
            className="h-8 text-sm"
          />
        </div>
        <label className="file-drop">
          <Upload className="h-4 w-4 flex-shrink-0" />
          <span className="truncate text-sm">
            {props.selectedFile ? props.selectedFile.name : "Choose PDF or TXT"}
          </span>
          <input
            accept=".txt,.text,.pdf,text/plain,application/pdf"
            className="sr-only"
            onChange={props.onFileChange}
            type="file"
          />
        </label>
        <Button
          className="w-full"
          disabled={!props.accessToken || props.documentsLoading || !props.selectedFile}
          size="sm"
          type="submit"
        >
          {props.documentsLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Upload document
        </Button>
        {props.uploadStatus ? (
          <Badge
            variant={isUploadError ? "destructive" : "success"}
            className="w-full justify-center py-1 text-xs"
          >
            {props.uploadStatus}
          </Badge>
        ) : null}
      </form>

      <Separator className="my-1" />

      {/* Document list — plain scrollable div, no Radix overhead */}
      <div className="source-list-scroll">
        <div className="source-list py-1">
          {props.documents.length === 0 ? (
            <p className="muted-copy px-1 py-3 text-center">
              {props.accessToken ? "No documents yet." : "Sign in to view documents."}
            </p>
          ) : (
            props.documents.map((doc) => (
              <div className="source-row" key={doc.documentId}>
                <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{doc.title}</p>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <DocumentStatusBadge status={doc.status} />
                    <span className="text-xs text-muted-foreground">
                      {formatSectionCount(doc.chunkCount)}
                    </span>
                  </div>
                </div>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        disabled={props.documentsLoading}
                        onClick={() => void props.onDelete(doc)}
                        aria-label={`Delete ${doc.title}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete document</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspector Tab
// ─────────────────────────────────────────────────────────────────────────────

function InspectorTab({ message }: { message: ChatMessage | null }) {
  if (!message) {
    return (
      <div className="inspector-tab-root">
        <div className="inspector-empty">
          <Activity className="h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium text-muted-foreground">No response selected</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Send a message and the AI reasoning trace will appear here.
          </p>
        </div>
      </div>
    );
  }

  const displayValidation = message.validation
    ? getDisplayValidation(message.validation, extractSources(message.toolCalls ?? []).length)
    : undefined;

  return (
    <div className="inspector-tab-root">
      <ScrollArea className="inspector-scroll">
        <div className="inspector-content-area">
          {/* Confidence section */}
          {displayValidation ? (
            <ConfidenceSection validation={displayValidation} />
          ) : null}

          {/* Tool execution trace */}
          {(message.toolCalls?.length ?? 0) > 0 ? (
            <TraceSection toolCalls={message.toolCalls!} />
          ) : null}

          {/* Empty state when message has no trace data yet */}
          {!message.validation && (message.toolCalls?.length ?? 0) === 0 ? (
            <div className="inspector-empty">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/50" />
              <p className="mt-2 text-xs text-muted-foreground">Waiting for response…</p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence Section
// ─────────────────────────────────────────────────────────────────────────────

type ValidationStatus = "grounded" | "partially_grounded" | "unsupported";

interface ValidationData {
  confidence: number;
  issues: string[];
  requiredCaveats: string[];
  status: ValidationStatus;
  supportedToolNames: string[];
}

function confidenceColor(pct: number): string {
  if (pct >= 80) return "var(--success)";
  if (pct >= 50) return "var(--warning)";
  return "var(--danger)";
}

function confidenceLabel(pct: number): string {
  if (pct >= 85) return "High confidence";
  if (pct >= 60) return "Moderate confidence";
  if (pct >= 35) return "Low confidence";
  return "Very low confidence";
}

function statusInfo(status: ValidationStatus) {
  switch (status) {
    case "grounded":
      return {
        icon: <ShieldCheck className="h-4 w-4" />,
        label: "Well supported",
        variant: "success" as const,
        desc: "Answer is grounded in the retrieved documents.",
      };
    case "partially_grounded":
      return {
        icon: <AlertTriangle className="h-4 w-4" />,
        label: "Partly supported",
        variant: "warning" as const,
        desc: "Some claims may not be fully backed by the source material.",
      };
    case "unsupported":
      return {
        icon: <XCircle className="h-4 w-4" />,
        label: "Needs review",
        variant: "destructive" as const,
        desc: "Could not find sufficient document evidence for this answer.",
      };
  }
}

function ConfidenceRing({ pct }: { pct: number }) {
  // SVG arc-based ring: r=36 → circumference ≈ 226
  const r = 36;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const color = confidenceColor(pct);

  return (
    <svg
      width="96"
      height="96"
      viewBox="0 0 96 96"
      className="confidence-ring"
      aria-label={`Confidence: ${pct}%`}
      role="img"
    >
      {/* Track */}
      <circle
        cx="48"
        cy="48"
        r={r}
        fill="none"
        stroke="var(--muted)"
        strokeWidth="8"
      />
      {/* Arc */}
      <circle
        cx="48"
        cy="48"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        strokeDashoffset={circ * 0.25} /* start at top */
        style={{ transition: "stroke-dasharray 0.6s ease" }}
      />
      {/* Percentage text */}
      <text
        x="48"
        y="48"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="18"
        fontWeight="800"
        fill={color}
      >
        {pct}%
      </text>
    </svg>
  );
}

function ConfidenceSection({ validation }: { validation: ValidationData }) {
  const pct = Math.round(validation.confidence * 100);
  const info = statusInfo(validation.status);

  return (
    <section className="inspector-section">
      <p className="inspector-section-label">Answer confidence</p>

      {/* Ring + label row */}
      <div className="confidence-row">
        <ConfidenceRing pct={pct} />
        <div className="confidence-meta">
          <Badge variant={info.variant} className="gap-1.5">
            {info.icon}
            {info.label}
          </Badge>
          <p className="mt-1.5 text-sm font-semibold" style={{ color: confidenceColor(pct) }}>
            {confidenceLabel(pct)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{info.desc}</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="confidence-bar-row">
        <span className="text-xs text-muted-foreground">0%</span>
        <div className="confidence-progress-track">
          <div
            className="confidence-progress-fill"
            style={{
              width: `${pct}%`,
              background: confidenceColor(pct),
            }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
        <span className="text-xs text-muted-foreground">100%</span>
      </div>

      {/* Issues */}
      {validation.issues.length > 0 ? (
        <div className="inspector-finding-list">
          <p className="inspector-finding-label">
            <AlertTriangle className="h-3 w-3 text-warning" />
            Validation issues
          </p>
          <ul className="inspector-finding-items">
            {validation.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Caveats */}
      {validation.requiredCaveats.length > 0 ? (
        <div className="inspector-finding-list">
          <p className="inspector-finding-label">
            <AlertCircle className="h-3 w-3 text-muted-foreground" />
            Required caveats
          </p>
          <ul className="inspector-finding-items">
            {validation.requiredCaveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace Section — tool execution steps
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_META: Record<
  string,
  { label: string; desc: string; icon: React.ComponentType<{ className?: string }> }
> = {
  "knowledge.retrieve": { label: "Source lookup", desc: "Knowledge base search", icon: Search },
  "document.extract_invoice_fields": {
    label: "Expense extraction",
    desc: "Invoice field parsing",
    icon: Receipt,
  },
  "calculator.evaluate": {
    label: "Calculation",
    desc: "Math expression evaluator",
    icon: Calculator,
  },
  "sql.query_safe": { label: "Workspace report", desc: "Read-only SQL query", icon: Database },
};

function getToolMeta(name: string) {
  return (
    TOOL_META[name] ?? {
      label: name
        .replace(/[._-]+/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase()),
      desc: `Tool: ${name}`,
      icon: Zap,
    }
  );
}

function TraceSection({ toolCalls }: { toolCalls: ToolCall[] }) {
  const succeeded = toolCalls.filter((t) => t.status === "succeeded").length;
  const failed = toolCalls.filter((t) => t.status === "failed").length;
  const totalMs = toolCalls.reduce((s, t) => s + (t.latencyMs ?? 0), 0);

  return (
    <section className="inspector-section">
      <p className="inspector-section-label">Tool execution trace</p>

      {/* Summary row */}
      <div className="trace-summary-row">
        <span className="text-xs text-muted-foreground">
          {toolCalls.length} step{toolCalls.length !== 1 ? "s" : ""}
        </span>
        <div className="flex items-center gap-2">
          {succeeded > 0 ? (
            <span className="flex items-center gap-1 text-xs font-medium text-success">
              <CheckCircle2 className="h-3 w-3" />
              {succeeded} ok
            </span>
          ) : null}
          {failed > 0 ? (
            <span className="flex items-center gap-1 text-xs font-medium text-danger">
              <XCircle className="h-3 w-3" />
              {failed} failed
            </span>
          ) : null}
          {totalMs > 0 ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {totalMs}ms
            </span>
          ) : null}
        </div>
      </div>

      {/* Steps — vertical timeline */}
      <ol className="trace-timeline" aria-label="Tool execution steps">
        {toolCalls.map((call, i) => (
          <TraceTimelineStep key={`${call.toolName}-${i}`} call={call} index={i} />
        ))}
      </ol>
    </section>
  );
}

function TraceTimelineStep({ call, index }: { call: ToolCall; index: number }) {
  const [open, setOpen] = useState(false);
  const meta = getToolMeta(call.toolName);
  const Icon = meta.icon;
  const hasBody = call.status === "failed" || call.output !== undefined;

  const dotClass =
    call.status === "succeeded"
      ? "trace-dot success"
      : call.status === "failed"
        ? "trace-dot failed"
        : "trace-dot running";

  return (
    <li className="trace-item">
      {/* Timeline line + dot */}
      <div className="trace-line-col">
        <div className={dotClass}>
          {call.status === "failed" ? (
            <XCircle className="h-2.5 w-2.5" />
          ) : (
            <CheckCircle2 className="h-2.5 w-2.5" />
          )}
        </div>
        <div className="trace-connector" />
      </div>

      {/* Content */}
      <div className="trace-item-body">
        <Collapsible open={open} onOpenChange={setOpen} disabled={!hasBody}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="trace-item-trigger"
              aria-expanded={open}
              disabled={!hasBody}
            >
              {/* Step icon */}
              <span
                className={
                  call.status === "succeeded"
                    ? "trace-tool-icon success"
                    : call.status === "failed"
                      ? "trace-tool-icon failed"
                      : "trace-tool-icon running"
                }
              >
                <Icon className="h-3.5 w-3.5" />
              </span>

              <div className="trace-item-meta">
                <span className="trace-item-name">
                  <span className="trace-step-num">Step {index + 1}</span>
                  {meta.label}
                </span>
                {call.reason ? (
                  <span className="trace-item-reason">{truncateText(call.reason, 72)}</span>
                ) : (
                  <span className="trace-item-reason">{meta.desc}</span>
                )}
              </div>

              <div className="trace-item-right">
                {call.latencyMs ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="trace-latency">
                          <Clock className="h-2.5 w-2.5" />
                          {call.latencyMs}ms
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Execution time</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : null}
                <Badge
                  variant={
                    call.status === "succeeded"
                      ? "success"
                      : call.status === "failed"
                        ? "destructive"
                        : "secondary"
                  }
                  className="shrink-0 text-[10px]"
                >
                  {call.status === "succeeded"
                    ? "Done"
                    : call.status === "failed"
                      ? "Failed"
                      : "Running"}
                </Badge>
                {hasBody ? (
                  open ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )
                ) : null}
              </div>
            </button>
          </CollapsibleTrigger>

          {hasBody ? (
            <CollapsibleContent>
              <div className="trace-item-output">
                <TraceOutput call={call} />
              </div>
            </CollapsibleContent>
          ) : null}
        </Collapsible>
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-tool output renderers
// ─────────────────────────────────────────────────────────────────────────────

function TraceOutput({ call }: { call: ToolCall }) {
  if (call.status === "failed") {
    return (
      <div className="trace-error-box">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span>{call.error?.message ?? call.error?.code ?? "Tool execution failed."}</span>
      </div>
    );
  }

  if (call.output === undefined || call.output === null) return null;

  switch (call.toolName) {
    case "knowledge.retrieve":
      return <RetrievalOutput output={call.output} />;
    case "sql.query_safe":
      return <SqlOutput output={call.output} />;
    case "calculator.evaluate":
      return <CalcOutput call={call} />;
    case "document.extract_invoice_fields":
      return <InvoiceOutput output={call.output} />;
    default:
      return <GenericOutput output={call.output} />;
  }
}

function RetrievalOutput({ output }: { output: unknown }) {
  const items = parseRetrievalResults(output);
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">No results returned.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground">
        {items.length} chunk{items.length !== 1 ? "s" : ""} retrieved
      </p>
      {items.map((r, i) => (
        <div key={i} className="trace-retrieval-chunk">
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium text-xs">{r.documentTitle}</span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {r.pageLabel}
            </Badge>
          </div>
          {r.excerpt ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{r.excerpt}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SqlOutput({ output }: { output: unknown }) {
  const rows = parseSqlRows(output);
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No rows returned.</p>;
  }
  const cols = Object.keys(rows[0] ?? {});
  return (
    <div className="trace-sql-result">
      <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
        {rows.length} row{rows.length !== 1 ? "s" : ""}
      </p>
      <div className="overflow-x-auto">
        <table className="tool-sql-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row, ri) => (
              <tr key={ri}>
                {cols.map((c) => (
                  <td key={c}>{String(row[c] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 8 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Showing 8 of {rows.length} rows
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CalcOutput({ call }: { call: ToolCall }) {
  const result = parseCalcResult(call.output);
  return (
    <div className="flex items-center gap-2">
      {call.reason ? (
        <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {truncateText(call.reason, 60)}
        </code>
      ) : null}
      {call.reason ? <span className="text-xs text-muted-foreground">=</span> : null}
      <span className="text-sm font-bold">{result ?? "—"}</span>
    </div>
  );
}

function InvoiceOutput({ output }: { output: unknown }) {
  const parsed = parseInvoiceOutput(output);
  if (!parsed) {
    return <p className="text-xs text-muted-foreground">No invoice data extracted.</p>;
  }
  return (
    <div className="space-y-1">
      {parsed.invoices.map((inv, i) => (
        <div key={i} className="flex justify-between text-xs">
          <span className="text-muted-foreground">
            {inv.vendor ?? inv.invoiceNumber ?? `Invoice ${i + 1}`}
          </span>
          <span className="font-medium">
            {parsed.currency} {inv.amount.toFixed(2)}
          </span>
        </div>
      ))}
      <Separator />
      <div className="flex justify-between text-xs font-bold text-primary">
        <span>Total</span>
        <span>
          {parsed.currency} {parsed.totalAmount.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function GenericOutput({ output }: { output: unknown }) {
  const preview = JSON.stringify(output, null, 2);
  return (
    <pre className="max-h-36 overflow-auto rounded-md bg-surface-muted px-2 py-1.5 text-xs text-muted-foreground">
      {truncateText(preview, 600)}
    </pre>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Output parsers
// ─────────────────────────────────────────────────────────────────────────────

function parseRetrievalResults(output: unknown) {
  if (!output || typeof output !== "object") return [];
  const raw = (output as { results?: unknown[] }).results;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    return [
      {
        chunkId: typeof r.chunkId === "string" ? r.chunkId : String(Math.random()),
        documentTitle:
          typeof r.documentTitle === "string" ? r.documentTitle : "Uploaded document",
        pageLabel:
          typeof r.sourcePageStart === "number" ? `Page ${r.sourcePageStart}` : "Matched section",
        excerpt:
          typeof r.chunkContent === "string" ? truncateText(r.chunkContent, 200) : undefined,
      },
    ];
  });
}

function parseSqlRows(output: unknown): Record<string, unknown>[] {
  if (!output || typeof output !== "object") return [];
  const rows = (output as { rows?: unknown[] }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
}

function parseCalcResult(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const r = output as Record<string, unknown>;
  const v = r.result ?? r.value ?? r.answer;
  return v !== undefined ? String(v) : null;
}

function parseInvoiceOutput(data: unknown) {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (
    typeof r.currency !== "string" ||
    typeof r.totalAmount !== "number" ||
    !Array.isArray(r.invoices)
  )
    return null;
  return {
    currency: r.currency,
    totalAmount: r.totalAmount,
    invoices: (r.invoices as unknown[]).map((item) => {
      const inv = item as Record<string, unknown>;
      return {
        amount: typeof inv.amount === "number" ? inv.amount : 0,
        invoiceNumber: typeof inv.invoiceNumber === "string" ? inv.invoiceNumber : undefined,
        vendor: typeof inv.vendor === "string" ? inv.vendor : undefined,
      };
    }),
  };
}
