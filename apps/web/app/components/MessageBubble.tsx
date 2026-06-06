"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Receipt,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatMessage, ChatResponse, SourceReference, ToolCall } from "../types";
import { extractSources, formatTime, getDisplayValidation, parseInvoiceOutput } from "../ui-utils";
import { ToolExecutionPanel } from "./ToolExecutionPanel";

// ── MessageBubble ─────────────────────────────────────────────────────────────

export function MessageBubble({
  message,
  isInspected,
  onInspect,
}: {
  message: ChatMessage;
  isInspected?: boolean | undefined;
  onInspect?: (() => void) | undefined;
}) {
  const sources = extractSources(message.toolCalls ?? []);
  const displayValidation = message.validation
    ? getDisplayValidation(message.validation, sources.length)
    : undefined;
  const hasTrace =
    (message.toolCalls?.length ?? 0) > 0 || message.validation !== undefined;

  return (
    <article
      className={message.role === "user" ? "message-row user" : "message-row assistant"}
    >
      <div className="message-avatar">
        {message.role === "user" ? "You" : <Sparkles className="h-4 w-4" />}
      </div>

      <div
        className={
          message.role === "assistant" && isInspected
            ? "message-bubble inspected"
            : "message-bubble"
        }
      >
        {/* Meta row — includes inspect button for assistant messages */}
        <div className="message-meta">
          <span>{message.role === "user" ? "You" : "Knoviq"}</span>
          <div className="flex items-center gap-1.5">
            <span>{formatTime(message.createdAt)}</span>
            {message.role === "assistant" && hasTrace && onInspect ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onInspect}
                      className={`message-inspect-btn${isInspected ? " active" : ""}`}
                      aria-label="View AI reasoning in inspector"
                    >
                      <Activity className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {isInspected ? "Shown in AI Inspector" : "Open in AI Inspector"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        </div>

        {/* Content */}
        {message.role === "assistant" ? (
          <div className="prose prose-sm max-w-none">
            {message.content ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            ) : (
              <span className="text-muted-foreground italic">Thinking…</span>
            )}
          </div>
        ) : (
          <p>{message.content}</p>
        )}

        {/* Assistant-only enrichments */}
        {message.role === "assistant" && (
          <>
            {/* Inline tool execution trace (collapsible in bubble) */}
            {(message.toolCalls?.length ?? 0) > 0 && (
              <ToolExecutionPanel toolCalls={message.toolCalls ?? []} />
            )}

            {/* Evidence quality chip */}
            <EvidenceChip sourcesCount={sources.length} validation={displayValidation} />

            {/* Collapsible source excerpts */}
            <MessageSources sources={sources} />

            {/* Invoice structured output */}
            <InvoiceSummary toolCalls={message.toolCalls ?? []} />
          </>
        )}
      </div>
    </article>
  );
}

// ── EvidenceChip ──────────────────────────────────────────────────────────────

export function EvidenceChip({
  sourcesCount,
  validation,
}: {
  sourcesCount: number;
  validation: ChatResponse["validation"] | undefined;
}) {
  if (!validation) return null;

  const pct = Math.round(validation.confidence * 100);

  if (validation.status === "unsupported") {
    return (
      <div className="validation-chip warning">
        <CircleAlert className="h-3.5 w-3.5" />
        Not enough document evidence
        <span className="ml-auto opacity-70">{pct}%</span>
      </div>
    );
  }

  if (validation.status === "partially_grounded") {
    return (
      <div className="validation-chip warning">
        <CircleAlert className="h-3.5 w-3.5" />
        Partly supported
        {sourcesCount > 0 ? ` · ${sourcesCount} source${sourcesCount !== 1 ? "s" : ""}` : ""}
        <span className="ml-auto opacity-70">{pct}%</span>
      </div>
    );
  }

  return (
    <div className="validation-chip">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {sourcesCount > 0
        ? `Answered from ${sourcesCount} source${sourcesCount === 1 ? "" : "s"}`
        : "Answer checked"}
      <span className="ml-auto opacity-70">{pct}%</span>
    </div>
  );
}

// ── MessageSources ────────────────────────────────────────────────────────────

export function MessageSources({ sources }: { sources: SourceReference[] }) {
  if (sources.length === 0) return null;

  return (
    <details className="message-sources">
      <summary>
        <BookOpen className="h-3.5 w-3.5" />
        Sources ({sources.length})
      </summary>
      <div className="source-excerpts">
        {sources.map((source) => (
          <div className="source-excerpt" key={source.chunkId}>
            <strong>{source.documentTitle}</strong>
            <span>{source.pageLabel}</span>
            {source.excerpt ? <p>{source.excerpt}</p> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

// ── InvoiceSummary ────────────────────────────────────────────────────────────

export function InvoiceSummary({ toolCalls }: { toolCalls: ToolCall[] }) {
  const invoiceTool = toolCalls.find(
    (call) => call.toolName === "document.extract_invoice_fields" && call.status === "succeeded",
  );
  const output = parseInvoiceOutput(invoiceTool?.output);

  if (!output) return null;

  return (
    <div className="invoice-panel mt-3">
      <div className="flex items-center gap-2">
        <Receipt className="h-4 w-4 text-primary" />
        <span className="font-semibold text-sm">Extracted expenses</span>
      </div>
      <div className="mt-3 space-y-2">
        {output.invoices.map((invoice, index) => (
          <div className="invoice-row" key={`${invoice.invoiceNumber ?? "invoice"}-${index}`}>
            <span>{invoice.vendor ?? invoice.invoiceNumber ?? `Invoice ${index + 1}`}</span>
            <strong>
              {output.currency} {invoice.amount.toFixed(2)}
            </strong>
          </div>
        ))}
      </div>
      <div className="invoice-total">
        <span>Total</span>
        <strong>
          {output.currency} {output.totalAmount.toFixed(2)}
        </strong>
      </div>
    </div>
  );
}

// ── TypingIndicator ───────────────────────────────────────────────────────────

export function TypingIndicator() {
  return (
    <article className="message-row assistant">
      <div className="message-avatar">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="message-bubble typing">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading your documents…
      </div>
    </article>
  );
}
