import { backendUnavailable, backendUrls, bearerHeaders } from "../../_lib/backend";

/**
 * SSE streaming proxy.
 *
 * Pipes the AI Gateway /chat/stream SSE response directly to the browser.
 * We forward the ReadableStream without buffering so the client sees tokens
 * as they arrive rather than waiting for the full answer.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const response = await fetch(`${backendUrls.aiGateway}/chat/stream`, {
      body: await request.text(),
      headers: {
        ...bearerHeaders(request),
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
      method: "POST",
      // Node 18+ fetch supports streaming response bodies
      // @ts-expect-error -- duplex is required in Node when streaming the request body
      duplex: "half",
    });

    if (!response.ok || !response.body) {
      // Surface upstream errors as plain JSON so the client can handle them
      const text = await response.text();
      return new Response(text, {
        headers: { "content-type": "application/json" },
        status: response.status,
      });
    }

    // Pipe the upstream SSE stream straight through to the browser
    return new Response(response.body, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
      status: 200,
    });
  } catch (error) {
    return backendUnavailable("AI Gateway", error);
  }
}
