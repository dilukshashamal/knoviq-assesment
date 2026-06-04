import {
  backendUnavailable,
  backendUrls,
  bearerHeaders,
  forwardJsonResponse,
} from "../_lib/backend";

export async function POST(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${backendUrls.aiGateway}/chat`, {
      body: await request.text(),
      headers: {
        ...bearerHeaders(request),
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
      method: "POST",
    });

    return forwardJsonResponse(response);
  } catch (error) {
    return backendUnavailable("AI Gateway", error);
  }
}
