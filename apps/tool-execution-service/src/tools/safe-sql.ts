import type { Pool } from "@knoviq/database";

import type { ToolSettings } from "../config.js";
import { badRequest } from "../errors.js";
import { SafeSqlArgumentsSchema, type SafeSqlArguments } from "../schemas.js";
import type { ToolExecutionContext, ToolHandler } from "../types.js";

export class SafeSqlTool implements ToolHandler<SafeSqlArguments> {
  definition = {
    description:
      "Runs approved read-only PostgreSQL reporting operations. The model chooses an operation and parameters, never raw SQL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: [
            "answer_quality_incidents",
            "answer_quality_trend",
            "answer_validation_summary",
            "document_count",
            "list_documents",
            "llm_usage_summary",
            "recent_tool_executions",
            "service_metric_summary",
            "tool_execution_summary",
          ],
        },
        status: {
          type: "string",
          description: "Optional status filter for document/tool operations.",
        },
        from: {
          type: "string",
          format: "date-time",
          description: "Optional inclusive start timestamp.",
        },
        to: {
          type: "string",
          format: "date-time",
          description: "Optional exclusive end timestamp.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
      },
    },
    name: "sql.query_safe" as const,
  };

  constructor(
    private readonly pool: Pool,
    private readonly settings: ToolSettings,
  ) {}

  async execute(args: SafeSqlArguments, context: ToolExecutionContext) {
    const parsed = SafeSqlArgumentsSchema.parse(args);
    const limit = Math.min(parsed.limit ?? 20, this.settings.sqlMaxLimit);

    switch (parsed.operation) {
      case "answer_quality_incidents":
        return this.answerQualityIncidents(parsed, context, limit);
      case "answer_quality_trend":
        return this.answerQualityTrend(parsed, context);
      case "answer_validation_summary":
        return this.answerValidationSummary(parsed, context);
      case "document_count":
        return this.documentCount(parsed, context);
      case "list_documents":
        return this.listDocuments(parsed, context, limit);
      case "llm_usage_summary":
        return this.llmUsageSummary(parsed, context);
      case "recent_tool_executions":
        return this.recentToolExecutions(parsed, context, limit);
      case "service_metric_summary":
        return this.serviceMetricSummary(parsed, context);
      case "tool_execution_summary":
        return this.toolExecutionSummary(parsed, context);
      default:
        throw badRequest("Unsupported SQL operation");
    }
  }

  private async answerQualityIncidents(
    args: SafeSqlArguments,
    context: ToolExecutionContext,
    limit: number,
  ) {
    const result = await this.pool.query(
      `
        WITH quality_messages AS (
          SELECT
            m.id,
            m.conversation_id,
            m.content,
            m.metadata,
            m.model_deployment,
            m.token_count,
            m.created_at,
            c.title AS conversation_title,
            u.email AS user_email,
            u.full_name AS user_name,
            previous_user.content AS user_question
          FROM knoviq.messages m
          JOIN knoviq.conversations c
            ON c.tenant_id = m.tenant_id
           AND c.id = m.conversation_id
          LEFT JOIN knoviq.users u
            ON u.id = c.user_id
          LEFT JOIN LATERAL (
            SELECT content
            FROM knoviq.messages
            WHERE tenant_id = m.tenant_id
              AND conversation_id = m.conversation_id
              AND role = 'user'
              AND created_at < m.created_at
            ORDER BY created_at DESC
            LIMIT 1
          ) previous_user ON true
          WHERE m.tenant_id = $1
            AND m.role = 'assistant'
            AND m.metadata ? 'validation'
            AND m.metadata->'validation'->>'status' IS NOT NULL
            AND m.created_at >= coalesce($2::timestamptz, now() - INTERVAL '30 days')
            AND ($3::timestamptz IS NULL OR m.created_at < $3)
            AND (
              ($4::text IS NULL AND m.metadata->'validation'->>'status' <> 'grounded')
              OR ($4::text IS NOT NULL AND m.metadata->'validation'->>'status' = $4)
            )
          ORDER BY
            CASE m.metadata->'validation'->>'status'
              WHEN 'unsupported' THEN 0
              WHEN 'partially_grounded' THEN 1
              ELSE 2
            END,
            m.created_at DESC
          LIMIT $5
        )
        SELECT
          qm.id AS message_id,
          qm.conversation_id,
          qm.conversation_title,
          qm.user_email,
          qm.user_name,
          qm.user_question,
          qm.content AS answer,
          qm.metadata->>'draftAnswer' AS draft_answer,
          qm.metadata->'validation'->>'status' AS validation_status,
          coalesce((qm.metadata->'validation'->>'confidence')::numeric, 0)::text
            AS validation_confidence,
          coalesce(qm.metadata->'validation'->'issues', '[]'::jsonb) AS validation_issues,
          coalesce(qm.metadata->'validation'->'requiredCaveats', '[]'::jsonb)
            AS required_caveats,
          coalesce(qm.metadata->'validation'->'supportedToolNames', '[]'::jsonb)
            AS supported_tool_names,
          qm.model_deployment,
          qm.token_count,
          qm.created_at,
          CASE qm.metadata->'validation'->>'status'
            WHEN 'unsupported' THEN 'high'
            WHEN 'partially_grounded' THEN 'medium'
            ELSE 'low'
          END AS review_priority,
          jsonb_array_length(coalesce(qm.metadata->'toolCalls', '[]'::jsonb))::int
            AS tool_call_count,
          (
            SELECT count(*)::int
            FROM jsonb_array_elements(coalesce(qm.metadata->'toolCalls', '[]'::jsonb)) tool_call
            WHERE tool_call->>'status' = 'failed'
          ) AS failed_tool_count,
          (
            SELECT count(*)::int
            FROM jsonb_array_elements(coalesce(qm.metadata->'toolCalls', '[]'::jsonb)) tool_call
            WHERE tool_call->>'toolName' = 'knowledge.retrieve'
          ) AS retrieval_count,
          (
            SELECT coalesce(sum(jsonb_array_length(coalesce(tool_call->'output'->'results', '[]'::jsonb))), 0)::int
            FROM jsonb_array_elements(coalesce(qm.metadata->'toolCalls', '[]'::jsonb)) tool_call
            WHERE tool_call->>'toolName' = 'knowledge.retrieve'
          ) AS retrieval_result_count,
          coalesce(
            (
              SELECT jsonb_agg(tool_call->'arguments'->>'query')
              FROM jsonb_array_elements(coalesce(qm.metadata->'toolCalls', '[]'::jsonb)) tool_call
              WHERE tool_call->>'toolName' = 'knowledge.retrieve'
                AND tool_call->'arguments'->>'query' IS NOT NULL
            ),
            '[]'::jsonb
          ) AS retrieval_queries,
          jsonb_build_object(
            'draftAnswer', qm.metadata->>'draftAnswer',
            'toolCalls', coalesce(qm.metadata->'toolCalls', '[]'::jsonb),
            'validation', qm.metadata->'validation'
          ) AS trace
        FROM quality_messages qm
      `,
      [context.tenantId, args.from ?? null, args.to ?? null, args.status ?? null, limit],
    );

    return {
      limit,
      operation: args.operation,
      rows: result.rows,
    };
  }

  private async answerQualityTrend(args: SafeSqlArguments, context: ToolExecutionContext) {
    const result = await this.pool.query(
      `
        WITH daily AS (
          SELECT
            date_trunc('day', created_at) AS bucket,
            metadata->'validation'->>'status' AS validation_status,
            count(*)::int AS count
          FROM knoviq.messages
          WHERE tenant_id = $1
            AND role = 'assistant'
            AND metadata ? 'validation'
            AND metadata->'validation'->>'status' IS NOT NULL
            AND created_at >= coalesce($2::timestamptz, now() - INTERVAL '30 days')
            AND ($3::timestamptz IS NULL OR created_at < $3)
          GROUP BY bucket, validation_status
        ),
        totals AS (
          SELECT
            bucket,
            sum(count)::int AS total_count,
            sum(CASE WHEN validation_status = 'unsupported' THEN count ELSE 0 END)::int
              AS unsupported_count
          FROM daily
          GROUP BY bucket
        )
        SELECT
          daily.bucket::date::text AS bucket,
          daily.validation_status,
          daily.count,
          totals.total_count,
          totals.unsupported_count,
          round((totals.unsupported_count::numeric / nullif(totals.total_count, 0)) * 100, 2)::text
            AS unsupported_rate
        FROM daily
        JOIN totals ON totals.bucket = daily.bucket
        ORDER BY daily.bucket DESC, daily.validation_status
      `,
      [context.tenantId, args.from ?? null, args.to ?? null],
    );

    return {
      operation: args.operation,
      rows: result.rows,
    };
  }

  private async answerValidationSummary(args: SafeSqlArguments, context: ToolExecutionContext) {
    const result = await this.pool.query(
      `
        SELECT
          metadata->'validation'->>'status' AS validation_status,
          count(*)::int AS count,
          round(avg((metadata->'validation'->>'confidence')::numeric), 2)::text
            AS average_confidence
        FROM knoviq.messages
        WHERE tenant_id = $1
          AND role = 'assistant'
          AND metadata ? 'validation'
          AND metadata->'validation'->>'status' IS NOT NULL
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at < $3)
        GROUP BY validation_status
        ORDER BY count DESC
      `,
      [context.tenantId, args.from ?? null, args.to ?? null],
    );

    return {
      operation: args.operation,
      rows: result.rows,
    };
  }

  private async documentCount(args: SafeSqlArguments, context: ToolExecutionContext) {
    const result = await this.pool.query(
      `
        SELECT status::text, count(*)::int AS count
        FROM knoviq.documents
        WHERE tenant_id = $1
          AND deleted_at IS NULL
          AND ($2::text IS NULL OR status::text = $2)
        GROUP BY status
        ORDER BY status
      `,
      [context.tenantId, args.status ?? null],
    );

    return {
      operation: args.operation,
      rows: result.rows,
    };
  }

  private async listDocuments(
    args: SafeSqlArguments,
    context: ToolExecutionContext,
    limit: number,
  ) {
    const result = await this.pool.query(
      `
        SELECT
          d.id,
          d.title,
          d.original_filename,
          d.status::text,
          d.visibility::text,
          d.chunk_count,
          d.created_at,
          d.processed_at
        FROM knoviq.documents d
        WHERE d.tenant_id = $1
          AND d.deleted_at IS NULL
          AND (
            d.owner_id = $2
            OR d.visibility = 'tenant'
            OR EXISTS (
              SELECT 1
              FROM knoviq.document_access_grants dag
              WHERE dag.tenant_id = d.tenant_id
                AND dag.document_id = d.id
                AND dag.user_id = $2
            )
          )
          AND ($3::text IS NULL OR d.status::text = $3)
        ORDER BY d.created_at DESC
        LIMIT $4
      `,
      [context.tenantId, context.userId, args.status ?? null, limit],
    );

    return {
      limit,
      operation: args.operation,
      rows: result.rows,
    };
  }

  private async llmUsageSummary(args: SafeSqlArguments, context: ToolExecutionContext) {
    const result = await this.pool.query(
      `
        SELECT
          purpose::text,
          provider,
          model_deployment,
          sum(prompt_tokens)::int AS prompt_tokens,
          sum(completion_tokens)::int AS completion_tokens,
          sum(total_tokens)::int AS total_tokens,
          coalesce(sum(estimated_cost_usd), 0)::text AS estimated_cost_usd,
          count(*)::int AS request_count
        FROM knoviq.llm_usage
        WHERE tenant_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at < $3)
        GROUP BY purpose, provider, model_deployment
        ORDER BY request_count DESC
      `,
      [context.tenantId, args.from ?? null, args.to ?? null],
    );

    return {
      operation: args.operation,
      rows: result.rows,
    };
  }

  private async recentToolExecutions(
    args: SafeSqlArguments,
    context: ToolExecutionContext,
    limit: number,
  ) {
    const result = await this.pool.query(
      `
        SELECT
          id,
          tool_name,
          status::text,
          latency_ms,
          error_code,
          created_at,
          completed_at
        FROM knoviq.tool_executions
        WHERE tenant_id = $1
          AND status <> 'running'
          AND ($2::text IS NULL OR status::text = $2)
          AND ($3::timestamptz IS NULL OR created_at >= $3)
          AND ($4::timestamptz IS NULL OR created_at < $4)
        ORDER BY created_at DESC
        LIMIT $5
      `,
      [context.tenantId, args.status ?? null, args.from ?? null, args.to ?? null, limit],
    );

    return {
      limit,
      operation: args.operation,
      rows: result.rows,
    };
  }

  private async toolExecutionSummary(args: SafeSqlArguments, context: ToolExecutionContext) {
    const result = await this.pool.query(
      `
        SELECT
          tool_name,
          status::text,
          count(*)::int AS count,
          round(avg(latency_ms))::int AS average_latency_ms
        FROM knoviq.tool_executions
        WHERE tenant_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at < $3)
          AND status <> 'running'
        GROUP BY tool_name, status
        ORDER BY tool_name, status
      `,
      [context.tenantId, args.from ?? null, args.to ?? null],
    );

    return {
      operation: args.operation,
      rows: result.rows,
    };
  }

  private async serviceMetricSummary(args: SafeSqlArguments, context: ToolExecutionContext) {
    const result = await this.pool.query(
      `
        SELECT
          service_name,
          metric_name,
          metric_kind::text,
          labels,
          count(*)::int AS sample_count,
          round(avg(value), 2)::text AS average_value,
          round(max(value), 2)::text AS max_value,
          unit
        FROM knoviq.service_metrics
        WHERE (tenant_id = $1 OR tenant_id IS NULL)
          AND ($2::timestamptz IS NULL OR recorded_at >= $2)
          AND ($3::timestamptz IS NULL OR recorded_at < $3)
        GROUP BY service_name, metric_name, metric_kind, labels, unit
        ORDER BY service_name, metric_name, sample_count DESC
      `,
      [context.tenantId, args.from ?? null, args.to ?? null],
    );

    return {
      operation: args.operation,
      rows: result.rows,
    };
  }
}
