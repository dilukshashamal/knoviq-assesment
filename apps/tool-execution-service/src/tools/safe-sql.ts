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
