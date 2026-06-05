/**
 * Shared domain types used across the chat UI components.
 * Keeping types in one place makes them easy to update when the
 * AI Gateway API contract changes.
 */

export interface DocumentSummary {
  chunkCount: number;
  createdAt: string;
  documentId: string;
  filename: string;
  status: string;
  title: string;
  visibility: string;
}

export interface ToolCall {
  error?: {
    code: string;
    message: string;
  };
  latencyMs?: number;
  output?: unknown;
  reason: string;
  status: "succeeded" | "failed";
  toolName: string;
}

export interface ChatResponse {
  answer: string;
  conversationId: string;
  requiresGroundedEvidence?: boolean;
  toolCalls: ToolCall[];
  validation: {
    confidence: number;
    issues: string[];
    requiredCaveats: string[];
    status: "grounded" | "partially_grounded" | "unsupported";
    supportedToolNames: string[];
  };
}

export interface ChatMessage {
  content: string;
  createdAt: string;
  id: string;
  role: "assistant" | "user";
  toolCalls?: ToolCall[];
  validation?: ChatResponse["validation"];
}

export interface ChatThread {
  conversationId?: string;
  createdAt: string;
  id: string;
  messages: ChatMessage[];
  title: string;
  updatedAt: string;
}

export interface SourceReference {
  chunkId: string;
  documentTitle: string;
  excerpt?: string;
  pageLabel: string;
}

export interface ApiErrorBody {
  code?: string;
  details?: string;
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}
