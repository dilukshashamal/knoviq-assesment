/**
 * Shared UI helper functions used across chat components.
 * Pure functions — no React imports, no side effects.
 */

import type { ApiErrorBody, ChatResponse, SourceReference, ToolCall } from "./types";

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatSourceCount(count: number): string {
  if (count === 0) return "No sources yet";
  return `${count} source${count === 1 ? "" : "s"} ready`;
}

export function formatSectionCount(count: number): string {
  return `${count} section${count === 1 ? "" : "s"}`;
}

export function formatDocumentStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "completed":
    case "processed":
    case "ready":
      return "Ready";
    case "failed":
    case "error":
      return "Needs attention";
    case "processing":
    case "queued":
    case "uploaded":
      return "Preparing";
    default:
      return titleCase(status);
  }
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function truncateText(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}...` : collapsed;
}

export function getDisplayValidation(
  validation: ChatResponse["validation"],
  sourcesCount: number,
): ChatResponse["validation"] {
  const hasSources = sourcesCount > 0;
  const status =
    validation.status === "unsupported" && hasSources ? "partially_grounded" : validation.status;
  const confidence =
    validation.confidence > 0
      ? validation.confidence
      : status === "partially_grounded"
        ? 0.7
        : status === "unsupported"
          ? 0.35
          : validation.confidence;

  return {
    ...validation,
    confidence,
    status,
  };
}

// ── Type guards ───────────────────────────────────────────────────────────────

export function isChatResponse(value: unknown): value is ChatResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatResponse>;
  return (
    typeof candidate.answer === "string" &&
    typeof candidate.conversationId === "string" &&
    Array.isArray(candidate.toolCalls) &&
    !!candidate.validation &&
    typeof candidate.validation === "object"
  );
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null;
}

// ── Error helpers ─────────────────────────────────────────────────────────────

export function extractApiMessage(data: unknown, status: number): string {
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

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

// ── Source extraction ─────────────────────────────────────────────────────────

export function extractSources(toolCalls: ToolCall[]): SourceReference[] {
  const sources: SourceReference[] = [];
  const seen = new Set<string>();

  for (const call of toolCalls) {
    if (call.toolName !== "knowledge.retrieve" || call.status !== "succeeded") continue;
    for (const result of parseRetrievalResults(call.output)) {
      if (seen.has(result.chunkId)) continue;
      seen.add(result.chunkId);
      sources.push(result);
    }
  }

  return sources.slice(0, 5);
}

function parseRetrievalResults(output: unknown): SourceReference[] {
  if (!output || typeof output !== "object") return [];
  const results = (output as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((result) => {
    if (!result || typeof result !== "object") return [];
    const record = result as Record<string, unknown>;
    const chunkId = typeof record.chunkId === "string" ? record.chunkId : crypto.randomUUID();
    const documentTitle =
      typeof record.documentTitle === "string" ? record.documentTitle : "Uploaded document";
    const pageStart = typeof record.sourcePageStart === "number" ? record.sourcePageStart : null;
    const excerpt =
      typeof record.chunkContent === "string" ? truncateText(record.chunkContent, 220) : undefined;
    return [
      {
        chunkId,
        documentTitle,
        ...(excerpt ? { excerpt } : {}),
        pageLabel: pageStart ? `Page ${pageStart}` : "Matched section",
      },
    ];
  });
}

// ── Invoice output ────────────────────────────────────────────────────────────

export interface ParsedInvoiceOutput {
  currency: string;
  invoices: Array<{ amount: number; invoiceNumber?: string; vendor?: string }>;
  totalAmount: number;
}

export function parseInvoiceOutput(data: unknown): ParsedInvoiceOutput | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (
    typeof record.currency !== "string" ||
    typeof record.totalAmount !== "number" ||
    !Array.isArray(record.invoices)
  ) {
    return null;
  }
  return {
    currency: record.currency,
    invoices: record.invoices.map((item) => {
      const inv = item as Record<string, unknown>;
      return {
        amount: typeof inv.amount === "number" ? inv.amount : 0,
        ...(typeof inv.invoiceNumber === "string" ? { invoiceNumber: inv.invoiceNumber } : {}),
        ...(typeof inv.vendor === "string" ? { vendor: inv.vendor } : {}),
      };
    }),
    totalAmount: record.totalAmount,
  };
}
