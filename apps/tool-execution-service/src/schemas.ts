import { z } from "zod";
import { toolNames } from "@knoviq/ai";

const ToolNameSchema = z.enum(toolNames);
const UuidSchema = z.string().uuid();

export const CalculatorArgumentsSchema = z.object({
  expression: z.string().trim().min(1).max(500),
  precision: z.coerce.number().int().min(0).max(12).optional(),
});

export const KnowledgeRetrieveArgumentsSchema = z.object({
  documentIds: z.array(UuidSchema).max(25).optional(),
  limit: z.coerce.number().int().positive().max(20).optional(),
  minSimilarity: z.coerce.number().min(-1).max(1).optional(),
  query: z.string().trim().min(1).max(4000),
});

export const InvoiceExtractionChunkSchema = z.object({
  chunkContent: z.string().trim().min(1).max(20_000),
  chunkId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  documentTitle: z.string().trim().min(1).max(300).optional(),
});

export const InvoiceExtractionArgumentsSchema = z.object({
  chunks: z.array(InvoiceExtractionChunkSchema).min(1).max(20),
  currency: z.string().trim().min(1).max(12).default("USD"),
  period: z.string().trim().min(1).max(80).optional(),
});

export const SafeSqlOperationSchema = z.enum([
  "document_count",
  "list_documents",
  "llm_usage_summary",
  "recent_tool_executions",
  "service_metric_summary",
  "tool_execution_summary",
]);

export const SafeSqlArgumentsSchema = z.object({
  from: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  operation: SafeSqlOperationSchema,
  status: z.string().trim().min(1).max(40).optional(),
  to: z.string().datetime().optional(),
});

export const ExecuteToolRequestSchema = z.object({
  arguments: z.unknown(),
  conversationId: UuidSchema.optional(),
  messageId: UuidSchema.optional(),
  toolName: ToolNameSchema,
});

export type CalculatorArguments = z.infer<typeof CalculatorArgumentsSchema>;
export type ExecuteToolRequest = z.infer<typeof ExecuteToolRequestSchema>;
export type InvoiceExtractionArguments = z.infer<typeof InvoiceExtractionArgumentsSchema>;
export type KnowledgeRetrieveArguments = z.infer<typeof KnowledgeRetrieveArgumentsSchema>;
export type SafeSqlArguments = z.infer<typeof SafeSqlArgumentsSchema>;
export type SafeSqlOperation = z.infer<typeof SafeSqlOperationSchema>;
export type ToolName = z.infer<typeof ToolNameSchema>;
