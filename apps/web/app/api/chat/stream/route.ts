import { backendUnavailable, backendUrls, bearerHeaders } from "../../_lib/backend";

/**
 * SSE streaming proxy.
 *
 * Pipes the AI Gateway /chat/stream SSE response directly to the browser.
 * force-dynamic prevents Next.js from caching or buffering this route.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.text();

    const upstream = await fetch(`${backendUrls.aiGateway}/chat/stream`, {
      body,
      headers: {
        ...bearerHeaders(request),
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
      method: "POST",
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return new Response(text, {
        headers: { "content-type": "application/json" },
        status: upstream.status,
      });
    }

    // Transform the upstream SSE stream: pass each chunk straight through
    // while keeping the connection alive so the browser receives events
    // incrementally rather than waiting for the full body.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    void upstream.body
      .pipeTo(
        new WritableStream({
          write(chunk) {
            return writer.write(chunk);
          },
          close() {
            return writer.close();
          },
          abort(reason) {
            return writer.abort(reason);
          },
        }),
      )
      .catch(() => writer.abort());

    return new Response(readable, {
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
