import {
  backendUnavailable,
  backendUrls,
  bearerHeaders,
  forwardJsonResponse,
} from "../../_lib/backend";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/conversations/:conversationId
 * Soft-deletes a conversation in the AI Gateway.
 * The conversation will no longer appear in the user's history on next login.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const { conversationId } = await context.params;
  try {
    const response = await fetch(`${backendUrls.aiGateway}/conversations/${conversationId}`, {
      headers: bearerHeaders(request),
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    return forwardJsonResponse(response);
  } catch (error) {
    return backendUnavailable("AI Gateway", error);
  }
}
