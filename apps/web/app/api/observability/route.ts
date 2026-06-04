import { backendUnavailable, backendUrls, bearerHeaders } from "../_lib/backend";

interface ToolExecutionResponse {
  error?: {
    code: string;
    message: string;
  };
  latencyMs: number;
  output?: unknown;
  status: "succeeded" | "failed";
  toolName: string;
}

const operations = [
  "llm_usage_summary",
  "tool_execution_summary",
  "service_metric_summary",
  "recent_tool_executions",
] as const;

export async function GET(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return Response.json(
      {
        code: "unauthorized",
        message: "Sign in to view observability data.",
      },
      { status: 401 },
    );
  }

  try {
    const results = await Promise.all(
      operations.map(async (operation) => {
        const response = await fetch(`${backendUrls.tools}/tools/execute`, {
          body: JSON.stringify({
            arguments: {
              operation,
            },
            toolName: "sql.query_safe",
          }),
          headers: {
            ...bearerHeaders(request),
            "content-type": "application/json",
          },
          method: "POST",
        });

        const payload = (await response.json()) as ToolExecutionResponse;
        return [operation, payload] as const;
      }),
    );

    return Response.json(Object.fromEntries(results));
  } catch (error) {
    return backendUnavailable("Tool Execution Service", error);
  }
}
