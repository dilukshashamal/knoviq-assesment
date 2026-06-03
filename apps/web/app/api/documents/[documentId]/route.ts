import {
  backendUnavailable,
  backendUrls,
  bearerHeaders,
  forwardJsonResponse,
} from "../../_lib/backend";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const params = await context.params;
  try {
    const response = await fetch(`${backendUrls.knowledge}/documents/${params.documentId}`, {
      headers: bearerHeaders(request),
      method: "DELETE",
    });

    return forwardJsonResponse(response);
  } catch (error) {
    return backendUnavailable("Knowledge Service", error);
  }
}
