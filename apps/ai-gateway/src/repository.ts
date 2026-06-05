import type { Pool, QueryResultRow } from "@knoviq/database";

import { forbidden, notFound } from "./errors.js";
import type { ChatRole, ConversationMessage, ExecutedToolCall } from "./types.js";

interface MessageRow extends QueryResultRow {
  content: string;
  created_at: Date;
  id: string;
  metadata: Record<string, unknown> | null;
  role: ChatRole;
}

interface ConversationRow extends QueryResultRow {
  id: string;
}

export class AiGatewayRepository {
  constructor(private readonly pool: Pool) {}

  async listConversations(input: {
    tenantId: string;
    userId: string;
  }): Promise<{ conversations: Array<{ id: string; title: string | null; lastMessageAt: string; createdAt: string }> }> {
    const result = await this.pool.query<{
      id: string;
      title: string | null;
      last_message_at: Date;
      created_at: Date;
    }>(
      `
        SELECT id, title, last_message_at, created_at
        FROM knoviq.conversations
        WHERE tenant_id = $1
          AND user_id = $2
          AND deleted_at IS NULL
          AND status = 'active'
        ORDER BY last_message_at DESC
        LIMIT 50
      `,
      [input.tenantId, input.userId],
    );

    return {
      conversations: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        lastMessageAt: row.last_message_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      })),
    };
  }

  async ensureMembership(tenantId: string, userId: string): Promise<void> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM knoviq.tenant_memberships tm
        JOIN knoviq.users u ON u.id = tm.user_id
        JOIN knoviq.tenants t ON t.id = tm.tenant_id
        WHERE tm.tenant_id = $1
          AND tm.user_id = $2
          AND u.status = 'active'
          AND t.status = 'active'
        LIMIT 1
      `,
      [tenantId, userId],
    );

    if (!result.rowCount) {
      throw forbidden("User is not a member of this tenant");
    }
  }

  async createConversation(input: {
    firstMessage: string;
    tenantId: string;
    userId: string;
  }): Promise<string> {
    const result = await this.pool.query<ConversationRow>(
      `
        INSERT INTO knoviq.conversations (tenant_id, user_id, title, last_message_at)
        VALUES ($1, $2, $3, now())
        RETURNING id
      `,
      [input.tenantId, input.userId, makeConversationTitle(input.firstMessage)],
    );
    const row = result.rows.at(0);

    if (!row) {
      throw new Error("Failed to create conversation");
    }

    return row.id;
  }

  async assertConversationAccess(input: {
    conversationId: string;
    tenantId: string;
    userId: string;
  }): Promise<void> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM knoviq.conversations
        WHERE tenant_id = $1
          AND id = $2
          AND user_id = $3
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [input.tenantId, input.conversationId, input.userId],
    );

    if (!result.rowCount) {
      throw notFound("Conversation was not found");
    }
  }

  async addMessage(input: {
    content: string;
    conversationId: string;
    metadata?: Record<string, unknown>;
    modelDeployment?: string;
    role: ChatRole;
    tenantId: string;
    tokenCount?: number;
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO knoviq.messages (
          tenant_id,
          conversation_id,
          role,
          content,
          metadata,
          token_count,
          model_deployment
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        RETURNING id
      `,
      [
        input.tenantId,
        input.conversationId,
        input.role,
        input.content,
        JSON.stringify(input.metadata ?? {}),
        input.tokenCount ?? null,
        input.modelDeployment ?? null,
      ],
    );

    await this.pool.query(
      `
        UPDATE knoviq.conversations
        SET last_message_at = now()
        WHERE tenant_id = $1
          AND id = $2
      `,
      [input.tenantId, input.conversationId],
    );

    const row = result.rows.at(0);

    if (!row) {
      throw new Error("Failed to create message");
    }

    return row.id;
  }

  async getRecentMessages(input: {
    conversationId: string;
    limit: number;
    tenantId: string;
  }): Promise<ConversationMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `
        SELECT id, role::text AS role, content, metadata, created_at
        FROM knoviq.messages
        WHERE tenant_id = $1
          AND conversation_id = $2
        ORDER BY created_at DESC
        LIMIT $3
      `,
      [input.tenantId, input.conversationId, input.limit],
    );

    return result.rows.reverse().map((row) => ({
      content: row.content,
      createdAt: row.created_at.toISOString(),
      id: row.id,
      metadata: row.metadata ?? {},
      role: row.role,
    }));
  }

  async recordToolMessage(input: {
    conversationId: string;
    tenantId: string;
    toolCalls: ExecutedToolCall[];
  }): Promise<void> {
    if (input.toolCalls.length === 0) {
      return;
    }

    await this.addMessage({
      content: JSON.stringify(input.toolCalls),
      conversationId: input.conversationId,
      metadata: { toolCount: input.toolCalls.length },
      role: "tool",
      tenantId: input.tenantId,
    });
  }

  /**
   * Writes one row per retrieved chunk into message_citations.
   * Called after the assistant message is created so the messageId is available.
   * Errors are swallowed — citation logging is best-effort and must never break
   * the chat response path.
   */
  async recordMessageCitations(input: {
    messageId: string;
    tenantId: string;
    toolCalls: ExecutedToolCall[];
  }): Promise<void> {
    const citations = extractCitationsFromToolCalls(input.toolCalls);

    if (citations.length === 0) {
      return;
    }

    try {
      for (const citation of citations) {
        await this.pool.query(
          `
            INSERT INTO knoviq.message_citations (
              tenant_id,
              message_id,
              document_id,
              chunk_id,
              relevance_score,
              quote
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (message_id, chunk_id) DO NOTHING
          `,
          [
            input.tenantId,
            input.messageId,
            citation.documentId,
            citation.chunkId,
            citation.relevanceScore,
            citation.quote,
          ],
        );
      }
    } catch {
      // Best-effort: citation persistence must not fail the chat response
    }
  }

  async recordLlmUsage(input: {
    cached?: boolean;
    conversationId: string;
    latencyMs: number;
    messageId?: string;
    modelDeployment: string;
    estimatedCostUsd?: number;
    promptTokens: number;
    completionTokens: number;
    purpose: "chat" | "tool_planning" | "answer_synthesis" | "validation" | "summarization";
    provider: "azure_openai" | "local";
    requestId: string;
    tenantId: string;
    userId: string;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO knoviq.llm_usage (
          tenant_id,
          user_id,
          conversation_id,
          message_id,
          request_id,
          purpose,
          provider,
          model_deployment,
          prompt_tokens,
          completion_tokens,
          estimated_cost_usd,
          latency_ms,
          cached
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `,
      [
        input.tenantId,
        input.userId,
        input.conversationId,
        input.messageId ?? null,
        input.requestId,
        input.purpose,
        input.provider,
        input.modelDeployment,
        input.promptTokens,
        input.completionTokens,
        input.estimatedCostUsd ?? null,
        input.latencyMs,
        input.cached ?? false,
      ],
    );
  }
}

function makeConversationTitle(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 80) || "New conversation";
}

interface CitationRecord {
  chunkId: string;
  documentId: string;
  quote: string | null;
  relevanceScore: number | null;
}

function extractCitationsFromToolCalls(toolCalls: ExecutedToolCall[]): CitationRecord[] {
  const seen = new Set<string>();
  const citations: CitationRecord[] = [];

  for (const tc of toolCalls) {
    if (tc.toolName !== "knowledge.retrieve" || tc.status !== "succeeded") {
      continue;
    }

    const output = tc.output as
      | {
          results?: Array<{
            chunkId?: string;
            documentId?: string;
            chunkContent?: string;
            score?: number;
          }>;
        }
      | undefined;

    for (const result of output?.results ?? []) {
      if (!result.chunkId || !result.documentId) {
        continue;
      }

      if (seen.has(result.chunkId)) {
        continue;
      }

      seen.add(result.chunkId);
      citations.push({
        chunkId: result.chunkId,
        documentId: result.documentId,
        quote: result.chunkContent?.slice(0, 500) ?? null,
        relevanceScore: typeof result.score === "number" ? result.score : null,
      });
    }
  }

  return citations;
}
