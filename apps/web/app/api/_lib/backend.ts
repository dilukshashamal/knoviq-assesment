const DEFAULT_BACKEND_URLS = {
  aiGateway: "http://127.0.0.1:4002",
  auth: "http://127.0.0.1:4001",
  knowledge: "http://127.0.0.1:4003",
  tools: "http://127.0.0.1:4004",
};

export const backendUrls = {
  aiGateway: trimTrailingSlash(
    process.env.AI_GATEWAY_URL ??
      process.env.NEXT_PUBLIC_AI_GATEWAY_URL ??
      DEFAULT_BACKEND_URLS.aiGateway,
  ),
  auth: trimTrailingSlash(
    process.env.AUTH_SERVICE_URL ??
      process.env.NEXT_PUBLIC_AUTH_SERVICE_URL ??
      DEFAULT_BACKEND_URLS.auth,
  ),
  knowledge: trimTrailingSlash(
    process.env.KNOWLEDGE_SERVICE_URL ??
      process.env.NEXT_PUBLIC_KNOWLEDGE_SERVICE_URL ??
      DEFAULT_BACKEND_URLS.knowledge,
  ),
  tools: trimTrailingSlash(
    process.env.TOOL_EXECUTION_SERVICE_URL ??
      process.env.NEXT_PUBLIC_TOOL_EXECUTION_SERVICE_URL ??
      DEFAULT_BACKEND_URLS.tools,
  ),
};

export function bearerHeaders(request: Request): HeadersInit {
  const authorization = request.headers.get("authorization");
  return authorization ? { authorization } : {};
}

export async function forwardJsonResponse(response: Response): Promise<Response> {
  // 204 No Content (and similar) must not carry a body — the Response constructor
  // will throw if you pass one with these status codes.
  const noBodyStatuses = [101, 204, 205, 304];
  if (noBodyStatuses.includes(response.status)) {
    return new Response(null, { status: response.status });
  }

  const contentType = response.headers.get("content-type") ?? "application/json";
  const body = await response.text();

  return new Response(body, {
    headers: {
      "content-type": contentType,
    },
    status: response.status,
  });
}

export function backendUnavailable(service: string, error: unknown): Response {
  return Response.json(
    {
      code: "backend_unavailable",
      message: `${service} is not reachable. Start the backend service and retry.`,
      details: error instanceof Error ? error.message : undefined,
    },
    { status: 503 },
  );
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/$/, "");
}
