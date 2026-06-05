import { backendUnavailable, backendUrls, bearerHeaders, forwardJsonResponse } from "../../../_lib/backend";

export const dynamic = "force-dynamic";

/**
 * GET /api/conversations/:conversationId/messages
 * Fetches the message history for a specific conversation from the AI Gateway.
 * Enables the UI to restore full backend-persisted conversation history.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const { conversationId } = await context.params;
  try {
    const response = await fetch(
      `${backendUrls.aiGateway}/conversations/${conversationId}/messages`,
      {
        headers: bearerHeaders(request),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return forwardJsonResponse(response);
  } catch (error) {
    return backendUnavailable("AI Gateway", error);
  }
}
