import type { Pool } from "@knoviq/database";

import type { ToolName } from "./schemas.js";

export class ToolExecutionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Marks any executions still in 'running' state as 'failed'.
   * Called once at service startup to recover from rows that were left
   * in-flight when the previous process was killed or crashed.
   *
   * Uses a threshold of 10 minutes — anything older than that cannot
   * possibly be a legitimate in-flight execution on the current process.
   */
  async recoverStaleExecutions(): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE knoviq.tool_executions
        SET status       = 'failed',
            error_code   = 'process_interrupted',
            error_message = 'Execution was interrupted when the service process restarted.',
            completed_at  = now(),
            latency_ms    = EXTRACT(EPOCH FROM (now() - started_at))::int * 1000
        WHERE status = 'running'
          AND started_at < now() - INTERVAL '10 minutes'
        RETURNING id
      `,
    );
    return result.rowCount ?? 0;
  }

  async startExecution(input: {
    arguments: unknown;
    conversationId: string | undefined;
    messageId: string | undefined;
    requestId: string;
    tenantId: string;
    toolName: ToolName;
    userId: string;
  }): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO knoviq.tool_executions (
          tenant_id,
          user_id,
          conversation_id,
          message_id,
          request_id,
          tool_name,
          status,
          input,
          started_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb, now())
        RETURNING id
      `,
      [
        input.tenantId,
        input.userId,
        input.conversationId ?? null,
        input.messageId ?? null,
        input.requestId,
        input.toolName,
        JSON.stringify(input.arguments),
      ],
    );
    const row = result.rows.at(0);

    if (!row) {
      throw new Error("Failed to create tool execution row");
    }

    return row.id;
  }

  async completeExecution(input: {
    executionId: string;
    latencyMs: number;
    output: unknown;
    tenantId: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE knoviq.tool_executions
        SET status = 'succeeded',
            output = $3::jsonb,
            completed_at = now(),
            latency_ms = $4
        WHERE tenant_id = $1
          AND id = $2
      `,
      [input.tenantId, input.executionId, JSON.stringify(input.output), input.latencyMs],
    );
  }

  async failExecution(input: {
    errorCode: string;
    errorMessage: string;
    executionId: string;
    latencyMs: number;
    tenantId: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE knoviq.tool_executions
        SET status = 'failed',
            error_code = $3,
            error_message = $4,
            completed_at = now(),
            latency_ms = $5
        WHERE tenant_id = $1
          AND id = $2
      `,
      [
        input.tenantId,
        input.executionId,
        input.errorCode,
        input.errorMessage.slice(0, 1000),
        input.latencyMs,
      ],
    );
  }
}
