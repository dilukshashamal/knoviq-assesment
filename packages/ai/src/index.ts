export const toolNames = [
  "calculator.evaluate",
  "knowledge.retrieve",
  "sql.query_safe",
  "document.extract_invoice_fields",
] as const;

export type ToolName = (typeof toolNames)[number];
export type ModelPurpose = "fast" | "reasoning" | "embedding";

export interface TokenUsage {
  completionTokens: number;
  estimatedCostUsd?: number;
  modelDeployment: string;
  promptTokens: number;
  totalTokens: number;
}

export interface ToolCallRequest<TArgs = unknown> {
  arguments: TArgs;
  id: string;
  name: ToolName;
}
