import { backendUnavailable, backendUrls, bearerHeaders } from "../../_lib/backend";

/**
 * True SSE streaming proxy for the AI Gateway /chat/stream endpoint.
 *
 * Uses a TransformStream owned by this Response so Next.js holds the
 * writable side open while we pipe the upstream body asynchronously.
 * This avoids the undici ReadableStream passthrough issue (where the
 * upstream stream is already closed before Next.js starts reading it)
 * and delivers each SSE event to the browser the moment it arrives from
 * the gateway — real incremental streaming, not a buffered response.
 *
 * force-dynamic prevents Next.js from caching this route.
 * maxDuration allows the full LLM pipeline to complete (~90s max).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const UPSTREAM_TIMEOUT_MS = 125_000;

export async function POST(request: Request): Promise<Response> {
  let upstream: Response;

  try {
    upstream = await fetch(`${backendUrls.aiGateway}/chat/stream`, {
      body: await request.text(),
      headers: {
        ...bearerHeaders(request),
        accept: "text/event-stream",
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    return backendUnavailable("AI Gateway", error);
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(text, {
      headers: { "content-type": "application/json" },
      status: upstream.status,
    });
  }

  // Create a TransformStream whose readable side becomes our response body.
  // We pipe the upstream into the writable side in the background — Next.js
  // flushes the readable side to the browser as each chunk arrives.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  // Pipe asynchronously — do NOT await here. The response is returned
  // immediately with the readable end; the writable end stays open and
  // receives chunks until the upstream closes.
  upstream.body.pipeTo(writable).catch(() => {
    // Upstream error: close the writable so the browser sees stream end.
    writable.abort().catch(() => undefined);
  });

  return new Response(readable, {
    headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
    status: 200,
  });
}
