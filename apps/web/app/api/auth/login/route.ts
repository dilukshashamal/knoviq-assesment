import { backendUrls, forwardJsonResponse } from "../../_lib/backend";

export async function POST(request: Request): Promise<Response> {
  const response = await fetch(`${backendUrls.auth}/auth/login`, {
    body: await request.text(),
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
    },
    method: "POST",
  });

  return forwardJsonResponse(response);
}
