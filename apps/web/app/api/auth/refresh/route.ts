import { backendUrls, forwardJsonResponse } from "../../_lib/backend";

/**
 * POST /api/auth/refresh
 * Exchanges a refresh token for a new access+refresh token pair.
 * Proxies to the auth service /auth/refresh endpoint.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${backendUrls.auth}/auth/refresh`, {
      body: await request.text(),
      headers: {
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    return forwardJsonResponse(response);
  } catch (error) {
    return Response.json(
      {
        code: "auth_service_unavailable",
        message: "Authentication service is not reachable.",
        details: error instanceof Error ? error.message : undefined,
      },
      { status: 503 },
    );
  }
}
