import {
  backendUnavailable,
  backendUrls,
  bearerHeaders,
  forwardJsonResponse,
} from "../_lib/backend";

export const dynamic = "force-dynamic";
// Allow up to 120s for the full LLM pipeline to complete.
export const maxDuration = 120;

// LLM pipeline can take up to 90s for complex queries with reranking.
// Set the upstream timeout beyond the client-side 120s abort so the
// gateway always finishes cleanly before the browser gives up.
const UPSTREAM_TIMEOUT_MS = 115_000;

export async function POST(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${backendUrls.aiGateway}/chat`, {
      body: await request.text(),
      headers: {
        ...bearerHeaders(request),
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    return forwardJsonResponse(response);
  } catch (error) {
    return backendUnavailable("AI Gateway", error);
  }
}
