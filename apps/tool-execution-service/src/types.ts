import type { ToolName } from "./schemas.js";

export type ToolExecutionStatus = "succeeded" | "failed";

export interface ToolExecutionContext {
  accessToken: string;
  conversationId?: string;
  messageId?: string;
  requestId: string;
  tenantId: string;
  userId: string;
}

export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  name: ToolName;
}

export interface ToolExecutionResult {
  executionId: string;
  output?: unknown;
  error?: {
    code: string;
    message: string;
  };
  latencyMs: number;
  status: ToolExecutionStatus;
  toolName: ToolName;
}

export interface ToolHandler<TArgs = unknown> {
  definition: ToolDefinition;
  execute(args: TArgs, context: ToolExecutionContext): Promise<unknown>;
}
