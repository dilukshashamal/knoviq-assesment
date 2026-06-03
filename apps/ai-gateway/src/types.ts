import type { ToolName } from "@knoviq/ai";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ConversationMessage {
  content: string;
  createdAt: string;
  id: string;
  metadata: Record<string, unknown>;
  role: ChatRole;
}

export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  name: ToolName;
}

export interface PlannedToolCall {
  arguments: unknown;
  reason: string;
  toolName: ToolName;
}

export interface ExecutedToolCall {
  arguments: unknown;
  executionId?: string;
  output?: unknown;
  error?: {
    code: string;
    message: string;
  };
  latencyMs?: number;
  reason: string;
  status: "succeeded" | "failed";
  toolName: ToolName;
}

export type AnswerValidationStatus = "grounded" | "partially_grounded" | "unsupported";

export interface AnswerValidation {
  confidence: number;
  issues: string[];
  requiredCaveats: string[];
  status: AnswerValidationStatus;
  supportedToolNames: ToolName[];
}

export interface AgentRunEvent {
  data: unknown;
  type:
    | "agent_step"
    | "conversation"
    | "error"
    | "final"
    | "message"
    | "tool_result"
    | "tool_start"
    | "validation";
}

export type AgentEventHandler = (event: AgentRunEvent) => void | Promise<void>;

export interface AgentRunResult {
  answer: string;
  assistantMessageId: string;
  conversationId: string;
  requiresGroundedEvidence: boolean;
  toolCalls: ExecutedToolCall[];
  validation: AnswerValidation;
}
