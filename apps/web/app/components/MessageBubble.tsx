"use client";

import ReactMarkdown from "react-markdown";
import { BookOpen, CheckCircle2, CircleAlert, Loader2, Receipt, Sparkles } from "lucide-react";

import type { ChatMessage, ChatResponse, SourceReference, ToolCall } from "../types";
import { extractSources, formatTime, parseInvoiceOutput } from "../ui-utils";

// ── MessageBubble ─────────────────────────────────────────────────────────────

export function MessageBubble(props: { message: ChatMessage }) {
  const sources = extractSources(props.message.toolCalls ?? []);

  return (
    <article
      className={props.message.role === "user" ? "message-row user" : "message-row assistant"}
    >
      <div className="message-avatar">
        {props.message.role === "user" ? "You" : <Sparkles className="h-4 w-4" />}
      </div>
      <div className="message-bubble">
        <div className="message-meta">
          <span>{props.message.role === "user" ? "You" : "Knoviq"}</span>
          <span>{formatTime(props.message.createdAt)}</span>
        </div>
        {props.message.role === "assistant" ? (
          <div className="prose prose-sm max-w-none">
            {props.message.content ? (
              <ReactMarkdown>{props.message.content}</ReactMarkdown>
            ) : (
              <span className="text-muted-foreground italic">Thinking…</span>
            )}
          </div>
        ) : (
          <p>{props.message.content}</p>
        )}
        {props.message.role === "assistant" ? (
          <>
            <EvidenceChip sourcesCount={sources.length} validation={props.message.validation} />
            <MessageSources sources={sources} />
            <InvoiceSummary toolCalls={props.message.toolCalls ?? []} />
          </>
        ) : null}
      </div>
    </article>
  );
}

// ── EvidenceChip ──────────────────────────────────────────────────────────────

export function EvidenceChip(props: {
  sourcesCount: number;
  validation: ChatResponse["validation"] | undefined;
}) {
  if (!props.validation) return null;

  if (props.validation.status === "unsupported") {
    return (
      <div className="validation-chip warning">
        <CircleAlert className="h-3.5 w-3.5" />
        Not enough document evidence
      </div>
    );
  }

  return (
    <div className="validation-chip">
      <CheckCircle2 className="h-3.5 w-3.5" />
      {props.sourcesCount > 0
        ? `Answered from ${props.sourcesCount} source${props.sourcesCount === 1 ? "" : "s"}`
        : "Answer checked"}
    </div>
  );
}

// ── MessageSources ────────────────────────────────────────────────────────────

export function MessageSources(props: { sources: SourceReference[] }) {
  if (props.sources.length === 0) return null;

  return (
    <details className="message-sources">
      <summary>
        <BookOpen className="h-3.5 w-3.5" />
        Sources
      </summary>
      <div className="source-excerpts">
        {props.sources.map((source) => (
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

export function InvoiceSummary(props: { toolCalls: ToolCall[] }) {
  const invoiceTool = props.toolCalls.find(
    (call) => call.toolName === "document.extract_invoice_fields",
  );
  const output = parseInvoiceOutput(invoiceTool?.output);

  if (!output) return null;

  return (
    <div className="invoice-panel">
      <div className="flex items-center gap-2">
        <Receipt className="h-4 w-4 text-primary" />
        <span className="font-semibold">Extracted expenses</span>
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
        Reading your documents
      </div>
    </article>
  );
}
