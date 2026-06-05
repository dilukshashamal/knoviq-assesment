import { backendUnavailable, backendUrls, bearerHeaders, forwardJsonResponse } from "../_lib/backend";

export const dynamic = "force-dynamic";

/**
 * GET /api/conversations
 * Returns the authenticated user's conversation list from the AI Gateway.
 * The UI uses this to restore server-side conversation history on login,
 * providing a backend-driven history rather than relying solely on localStorage.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${backendUrls.aiGateway}/conversations`, {
      headers: bearerHeaders(request),
      signal: AbortSignal.timeout(10_000),
    });
    return forwardJsonResponse(response);
  } catch (error) {
    return backendUnavailable("AI Gateway", error);
  }
}
