import { z } from "zod";
import { toolNames } from "@knoviq/ai";

import type { PlannedToolCall } from "./types.js";

const UuidSchema = z.string().uuid();
const ToolNameSchema = z.enum(toolNames);

const CalculatorArgumentsSchema = z.object({
  expression: z.string().trim().min(1).max(500),
  precision: z.coerce.number().int().min(0).max(12).optional(),
});

const KnowledgeRetrieveArgumentsSchema = z.object({
  documentIds: z.array(UuidSchema).max(25).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, 20))
    .optional(),
  minSimilarity: z.coerce.number().min(-1).max(1).optional(),
  query: z.string().trim().min(1).max(4000),
});

const InvoiceExtractionChunkSchema = z.object({
  chunkContent: z.string().trim().min(1).max(20_000),
  chunkId: UuidSchema.optional(),
  documentId: UuidSchema.optional(),
  documentTitle: z.string().trim().min(1).max(300).optional(),
});

const InvoiceExtractionArgumentsSchema = z.object({
  chunks: z.array(InvoiceExtractionChunkSchema).min(1).max(20),
  currency: z.string().trim().min(1).max(12).default("USD"),
  period: z.string().trim().min(1).max(80).optional(),
});

const SafeSqlArgumentsSchema = z.object({
  from: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  operation: z.enum([
    "answer_quality_incidents",
    "answer_quality_trend",
    "answer_validation_summary",
    "document_count",
    "list_documents",
    "llm_usage_summary",
    "recent_tool_executions",
    "service_metric_summary",
    "tool_execution_summary",
  ]),
  status: z.string().trim().min(1).max(40).optional(),
  to: z.string().datetime().optional(),
});

export function normalizePlannedToolCalls(
  toolCalls: PlannedToolCall[],
  fallbackUserMessage: string,
): PlannedToolCall[] {
  return toolCalls
    .map((toolCall) => normalizePlannedToolCall(toolCall, fallbackUserMessage))
    .filter((toolCall): toolCall is PlannedToolCall => toolCall !== undefined);
}

export function normalizePlannedToolCall(
  toolCall: PlannedToolCall,
  fallbackUserMessage: string,
): PlannedToolCall | undefined {
  if (!ToolNameSchema.safeParse(toolCall.toolName).success) {
    return undefined;
  }

  switch (toolCall.toolName) {
    case "calculator.evaluate":
      return normalizeCalculatorCall(toolCall);
    case "document.extract_invoice_fields":
      return normalizeInvoiceExtractionCall(toolCall);
    case "knowledge.retrieve":
      return normalizeKnowledgeRetrievalCall(toolCall, fallbackUserMessage);
    case "sql.query_safe":
      return normalizeSafeSqlCall(toolCall);
    default:
      return undefined;
  }
}

export function sanitizeToolText(input: string, maxLength: number): string {
  return stripControlCharacters(input)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function stripControlCharacters(input: string): string {
  let output = "";

  for (const char of input) {
    const code = char.charCodeAt(0);
    output += (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127 ? " " : char;
  }

  return output;
}

function normalizeKnowledgeRetrievalCall(
  toolCall: PlannedToolCall,
  fallbackUserMessage: string,
): PlannedToolCall {
  const parsed = KnowledgeRetrieveArgumentsSchema.safeParse(toolCall.arguments);
  const source = parsed.success ? parsed.data : { query: fallbackUserMessage, limit: 5 };
  const query = sanitizeToolText(source.query || fallbackUserMessage, 4000);
  const args: Record<string, unknown> = {
    limit: source.limit ?? 5,
    query: query || sanitizeToolText(fallbackUserMessage, 4000),
  };

  if (source.documentIds?.length) {
    args.documentIds = source.documentIds;
  }

  if (source.minSimilarity !== undefined) {
    args.minSimilarity = source.minSimilarity;
  }

  return {
    ...toolCall,
    arguments: args,
  };
}

function normalizeCalculatorCall(toolCall: PlannedToolCall): PlannedToolCall | undefined {
  const parsed = CalculatorArgumentsSchema.safeParse(toolCall.arguments);

  if (!parsed.success) {
    return undefined;
  }

  return {
    ...toolCall,
    arguments: parsed.data,
  };
}

function normalizeSafeSqlCall(toolCall: PlannedToolCall): PlannedToolCall | undefined {
  const parsed = SafeSqlArgumentsSchema.safeParse(toolCall.arguments);

  if (!parsed.success) {
    return undefined;
  }

  return {
    ...toolCall,
    arguments: parsed.data,
  };
}

function normalizeInvoiceExtractionCall(toolCall: PlannedToolCall): PlannedToolCall | undefined {
  const parsed = InvoiceExtractionArgumentsSchema.safeParse(toolCall.arguments);

  if (!parsed.success) {
    return undefined;
  }

  return {
    ...toolCall,
    arguments: {
      chunks: parsed.data.chunks.map((chunk) => {
        const normalizedChunk: Record<string, string> = {
          chunkContent: sanitizeToolText(chunk.chunkContent, 20_000),
        };

        if (chunk.chunkId) normalizedChunk.chunkId = chunk.chunkId;
        if (chunk.documentId) normalizedChunk.documentId = chunk.documentId;
        if (chunk.documentTitle) {
          normalizedChunk.documentTitle = sanitizeToolText(chunk.documentTitle, 300);
        }

        return normalizedChunk;
      }),
      currency: sanitizeToolText(parsed.data.currency, 12),
      ...(parsed.data.period
        ? { period: sanitizeToolText(parsed.data.period, 80) }
        : {}),
    },
  };
}
