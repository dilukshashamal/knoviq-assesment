"use client";

import { useState } from "react";
import {
  AlertCircle,
  Calculator,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  FileSearch,
  Loader2,
  Receipt,
  Search,
  XCircle,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ToolCall } from "../types";
import { truncateText } from "../ui-utils";

// ── Tool metadata ─────────────────────────────────────────────────────────────

interface ToolMeta {
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const TOOL_META: Record<string, ToolMeta> = {
  "knowledge.retrieve": {
    label: "Source lookup",
    description: "Searched the knowledge base for relevant document sections",
    icon: Search,
  },
  "document.extract_invoice_fields": {
    label: "Expense extraction",
    description: "Extracted invoice fields from the uploaded document",
    icon: Receipt,
  },
  "calculator.evaluate": {
    label: "Calculation",
    description: "Evaluated a mathematical expression",
    icon: Calculator,
  },
  "sql.query_safe": {
    label: "Workspace report",
    description: "Ran a read-only query against workspace data",
    icon: Database,
  },
};

function getToolMeta(toolName: string): ToolMeta {
  return (
    TOOL_META[toolName] ?? {
      label: formatToolName(toolName),
      description: `Executed tool: ${toolName}`,
      icon: Zap,
    }
  );
}

function formatToolName(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

// ── Status helpers ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "succeeded") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Done
      </Badge>
    );
  }
  if (status === "failed") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="h-3 w-3 animate-spin" />
      Running
    </Badge>
  );
}

function ToolIconWrapper({
  status,
  Icon,
}: {
  status: string;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  const cls =
    status === "succeeded"
      ? "tool-step-icon success"
      : status === "failed"
        ? "tool-step-icon failed"
        : "tool-step-icon running";
  return (
    <div className={cls}>
      <Icon className="h-4 w-4" />
    </div>
  );
}

// ── Per-tool output renderers ─────────────────────────────────────────────────

function RetrievalOutput({ output }: { output: unknown }) {
  const results = parseRetrievalResults(output);
  if (results.length === 0) return <p className="text-xs text-muted-foreground">No results.</p>;

  return (
    <div className="tool-retrieval-sources">
      {results.map((r, i) => (
        <div className="tool-retrieval-source" key={`${r.chunkId}-${i}`}>
          <strong>{r.documentTitle}</strong>
          <span>{r.pageLabel}</span>
          {r.excerpt ? <p>{r.excerpt}</p> : null}
        </div>
      ))}
    </div>
  );
}

function SqlOutput({ output }: { output: unknown }) {
  const rows = parseSqlRows(output);
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No rows returned.</p>;

  const cols = Object.keys(rows[0] ?? {});
  return (
    <div className="tool-sql-result">
      <table className="tool-sql-table">
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 10).map((row, ri) => (
            <tr key={ri}>
              {cols.map((col) => (
                <td key={col}>{String(row[col] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 10 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing 10 of {rows.length} rows
        </p>
      ) : null}
    </div>
  );
}

function CalcOutput({ toolCall }: { toolCall: ToolCall }) {
  const result = parseCalcResult(toolCall.output);
  const expression = parseCalcExpression(toolCall);

  return (
    <div className="tool-calc-result">
      {expression ? (
        <span className="tool-calc-expression">{expression} =</span>
      ) : null}
      <strong>{result ?? "—"}</strong>
    </div>
  );
}

function InvoiceOutput({ output }: { output: unknown }) {
  const parsed = parseInvoiceOutput(output);
  if (!parsed) return <p className="text-xs text-muted-foreground">No invoice data extracted.</p>;

  return (
    <div className="space-y-1">
      {parsed.invoices.map((inv, i) => (
        <div key={i} className="flex justify-between text-sm">
          <span>{inv.vendor ?? inv.invoiceNumber ?? `Invoice ${i + 1}`}</span>
          <span className="font-medium">
            {parsed.currency} {inv.amount.toFixed(2)}
          </span>
        </div>
      ))}
      <Separator />
      <div className="flex justify-between text-sm font-bold text-primary">
        <span>Total</span>
        <span>
          {parsed.currency} {parsed.totalAmount.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function GenericOutput({ output }: { output: unknown }) {
  if (output === null || output === undefined) return null;
  const preview = JSON.stringify(output, null, 2);
  return (
    <pre className="max-h-40 overflow-auto rounded-md bg-surface-muted p-2 text-xs text-muted-foreground">
      {truncateText(preview, 800)}
    </pre>
  );
}

function ToolOutput({ toolCall }: { toolCall: ToolCall }) {
  if (toolCall.status === "failed") {
    return (
      <div className="tool-step-error">
        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
        <span>{toolCall.error?.message ?? toolCall.error?.code ?? "Tool execution failed."}</span>
      </div>
    );
  }

  if (toolCall.output === undefined || toolCall.output === null) return null;

  switch (toolCall.toolName) {
    case "knowledge.retrieve":
      return <RetrievalOutput output={toolCall.output} />;
    case "sql.query_safe":
      return <SqlOutput output={toolCall.output} />;
    case "calculator.evaluate":
      return <CalcOutput toolCall={toolCall} />;
    case "document.extract_invoice_fields":
      return <InvoiceOutput output={toolCall.output} />;
    default:
      return <GenericOutput output={toolCall.output} />;
  }
}

// ── Individual step ───────────────────────────────────────────────────────────

function ToolStep({ toolCall }: { toolCall: ToolCall }) {
  const [open, setOpen] = useState(false);
  const meta = getToolMeta(toolCall.toolName);
  const Icon = meta.icon;
  const hasBody = toolCall.status === "failed" || toolCall.output !== undefined;

  return (
    <div className="tool-step">
      <Collapsible open={open} onOpenChange={setOpen} disabled={!hasBody}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="tool-step-header w-full text-left"
            aria-expanded={open}
            disabled={!hasBody}
          >
            <ToolIconWrapper status={toolCall.status} Icon={Icon} />
            <div className="tool-step-meta">
              <span className="tool-step-name">{meta.label}</span>
              {toolCall.reason ? (
                <span className="tool-step-reason">{truncateText(toolCall.reason, 80)}</span>
              ) : (
                <span className="tool-step-reason">{meta.description}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={toolCall.status} />
              {toolCall.latencyMs ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="tool-step-latency flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {toolCall.latencyMs}ms
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Tool execution time</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              {hasBody ? (
                open ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )
              ) : null}
            </div>
          </button>
        </CollapsibleTrigger>
        {hasBody ? (
          <CollapsibleContent>
            <div className="tool-step-body">
              <ToolOutput toolCall={toolCall} />
            </div>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </div>
  );
}

// ── Panel summary ─────────────────────────────────────────────────────────────

function PanelSummary({ toolCalls }: { toolCalls: ToolCall[] }) {
  const succeeded = toolCalls.filter((t) => t.status === "succeeded").length;
  const failed = toolCalls.filter((t) => t.status === "failed").length;
  const totalMs = toolCalls.reduce((s, t) => s + (t.latencyMs ?? 0), 0);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>
        {toolCalls.length} step{toolCalls.length !== 1 ? "s" : ""}
      </span>
      {succeeded > 0 ? (
        <span className="flex items-center gap-1 text-success">
          <CheckCircle2 className="h-3 w-3" />
          {succeeded} succeeded
        </span>
      ) : null}
      {failed > 0 ? (
        <span className="flex items-center gap-1 text-danger">
          <XCircle className="h-3 w-3" />
          {failed} failed
        </span>
      ) : null}
      {totalMs > 0 ? (
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {totalMs}ms total
        </span>
      ) : null}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function ToolExecutionPanel({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [open, setOpen] = useState(false);

  if (toolCalls.length === 0) return null;

  const hasFailure = toolCalls.some((t) => t.status === "failed");

  return (
    <div className="tool-execution-panel">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="tool-execution-header w-full"
            aria-expanded={open}
          >
            <FileSearch className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground">
              {open ? "Hide" : "Show"} reasoning steps
            </span>
            {hasFailure ? (
              <Badge variant="destructive" className="ml-1 gap-1 text-xs">
                <AlertCircle className="h-3 w-3" />
                Error
              </Badge>
            ) : null}
            <div className="ml-auto">
              {open ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2">
            <PanelSummary toolCalls={toolCalls} />
            <div className="tool-steps mt-3">
              {toolCalls.map((toolCall, i) => (
                <ToolStep key={`${toolCall.toolName}-${i}`} toolCall={toolCall} />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Output parsers (local, no import cycle) ────────────────────────────────────

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
          typeof r.sourcePageStart === "number"
            ? `Page ${r.sourcePageStart}`
            : "Matched section",
        excerpt:
          typeof r.chunkContent === "string"
            ? truncateText(r.chunkContent, 240)
            : undefined,
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
  const result = r.result ?? r.value ?? r.answer;
  return result !== undefined ? String(result) : null;
}

function parseCalcExpression(toolCall: ToolCall): string | null {
  if (!toolCall.reason) return null;
  return truncateText(toolCall.reason, 60);
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
