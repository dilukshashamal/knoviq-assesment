import {
  backendUnavailable,
  backendUrls,
  bearerHeaders,
  forwardJsonResponse,
} from "../_lib/backend";

export async function GET(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${backendUrls.knowledge}/documents`, {
      headers: bearerHeaders(request),
    });

    return forwardJsonResponse(response);
  } catch (error) {
    return backendUnavailable("Knowledge Service", error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${backendUrls.knowledge}/documents`, {
      body: await request.formData(),
      headers: bearerHeaders(request),
      method: "POST",
    });

    return forwardJsonResponse(response);
  } catch (error) {
    return backendUnavailable("Knowledge Service", error);
  }
}
