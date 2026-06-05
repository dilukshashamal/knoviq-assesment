import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import type { AgentRunner } from "./agent-runner.js";
import type { AiGatewaySettings } from "./config.js";
import { unauthorized } from "./errors.js";
import { parseBearerToken, verifyAccessToken } from "./jwt.js";
import type { AuthenticatedFixedWindowRateLimiter } from "./rate-limiter.js";
import { ChatRequestSchema } from "./schemas.js";
import type { AgentRunEvent } from "./types.js";

const WebSocketAuthQuerySchema = z.object({
  accessToken: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
});

export function registerChatRoutes(
  app: FastifyInstance,
  agentRunner: AgentRunner,
  settings: AiGatewaySettings,
  llmRateLimiter: AuthenticatedFixedWindowRateLimiter,
) {
  const authenticateAndRateLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    const allowed = await enforceLlmRateLimit(request, reply, llmRateLimiter);

    if (!allowed) {
      return reply;
    }
  };

  app.post("/chat", { preHandler: authenticateAndRateLimit }, async (request) => {
    const principal = requirePrincipal(request);
    const body = ChatRequestSchema.parse(request.body);

    if (!request.accessToken) {
      throw unauthorized();
    }

    const runInput = {
      accessToken: request.accessToken,
      message: body.message,
      requestId: request.id,
      tenantId: principal.tenantId,
      userId: principal.userId,
    };

    return agentRunner.run(
      body.conversationId === undefined
        ? runInput
        : { ...runInput, conversationId: body.conversationId },
    );
  });

  app.post("/chat/stream", { preHandler: authenticateAndRateLimit }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = ChatRequestSchema.parse(request.body);

    if (!request.accessToken) {
      throw unauthorized();
    }

    reply.hijack();
    prepareSse(reply);

    try {
      const runInput = {
        accessToken: request.accessToken,
        emit: async (event: AgentRunEvent) => {
          writeSse(reply, event);
        },
        message: body.message,
        requestId: request.id,
        tenantId: principal.tenantId,
        userId: principal.userId,
      };

      await agentRunner.run(
        body.conversationId === undefined
          ? runInput
          : { ...runInput, conversationId: body.conversationId },
      );
      writeSse(reply, { data: "[DONE]", type: "done" });
    } catch (error) {
      writeSse(reply, {
        data: {
          message: error instanceof Error ? error.message : "Streaming chat failed",
        },
        type: "error",
      });
    } finally {
      reply.raw.end();
    }
  });

  app.route({
    handler: async (_request, reply) =>
      reply.code(426).send({
        error: {
          code: "upgrade_required",
          message: "Use a WebSocket client for /chat/ws",
        },
      }),
    method: "GET",
    preHandler: async (request) => {
      const token = parseStreamingAccessToken(request);
      request.accessToken = token;
      request.principal = await verifyAccessToken(token, settings);
    },
    url: "/chat/ws",
    wsHandler: (connection: WebSocket, request: FastifyRequest) => {
      let activeRun = false;

      connection.on("message", (rawMessage) => {
        if (activeRun) {
          writeWebSocketEvent(connection, {
            data: { message: "A chat run is already active on this WebSocket" },
            type: "error",
          });
          return;
        }

        activeRun = true;
        void handleWebSocketChatMessage({
          agentRunner,
          connection,
          llmRateLimiter,
          rawMessage,
          request,
        }).finally(() => {
          activeRun = false;
        });
      });

      writeWebSocketEvent(connection, {
        data: {
          status: "ready",
        },
        type: "agent_step",
      });
    },
  });
}

function requirePrincipal(request: FastifyRequest) {
  if (!request.principal) {
    throw unauthorized();
  }

  return request.principal;
}

function prepareSse(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "transfer-encoding": "chunked",
    "x-accel-buffering": "no",
  });
}

function writeSse(reply: FastifyReply, event: AgentRunEvent): void {
  // Write the full SSE frame atomically in one write() call.
  // Splitting event: and data: into two separate writes risks them landing
  // in separate TCP chunks, which breaks the client-side block parser.
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  reply.raw.write(frame);

  // Explicitly flush the socket after every event so chunks reach the
  // browser immediately instead of being held in Node's TCP write buffer.
  // This is critical for short responses (greetings) where Node may buffer
  // the entire body before flushing if we don't force it.
  const socket = (reply.raw as unknown as { socket?: { flush?: () => void } }).socket;
  if (socket?.flush) {
    socket.flush();
  }
}

function parseStreamingAccessToken(request: FastifyRequest): string {
  if (request.headers.authorization) {
    return parseBearerToken(request.headers.authorization);
  }

  const query = WebSocketAuthQuerySchema.parse(request.query);
  const token = query.accessToken ?? query.token;

  if (!token) {
    throw unauthorized("Missing WebSocket access token");
  }

  return token;
}

async function handleWebSocketChatMessage(input: {
  agentRunner: AgentRunner;
  connection: WebSocket;
  llmRateLimiter: AuthenticatedFixedWindowRateLimiter;
  rawMessage: WebSocket.RawData;
  request: FastifyRequest;
}): Promise<void> {
  try {
    const principal = requirePrincipal(input.request);

    if (!input.request.accessToken) {
      throw unauthorized();
    }

    const decision = await consumeLlmRateLimit(input.request, input.llmRateLimiter);

    if (!decision.allowed) {
      writeWebSocketEvent(input.connection, {
        data: {
          code: "rate_limit_exceeded",
          limit: decision.limit,
          message: `Too many LLM requests. Retry after ${String(decision.resetAfterSeconds)} seconds.`,
          resetAfterSeconds: decision.resetAfterSeconds,
        },
        type: "error",
      });
      return;
    }

    const body = ChatRequestSchema.parse(JSON.parse(input.rawMessage.toString()));
    const runInput = {
      accessToken: input.request.accessToken,
      emit: async (event: AgentRunEvent) => {
        writeWebSocketEvent(input.connection, event);
      },
      message: body.message,
      requestId: input.request.id,
      tenantId: principal.tenantId,
      userId: principal.userId,
    };

    await input.agentRunner.run(
      body.conversationId === undefined
        ? runInput
        : { ...runInput, conversationId: body.conversationId },
    );
    writeWebSocketEvent(input.connection, { data: "[DONE]", type: "done" });
  } catch (error) {
    writeWebSocketEvent(input.connection, {
      data: {
        message: error instanceof Error ? error.message : "WebSocket chat failed",
      },
      type: "error",
    });
  }
}

function writeWebSocketEvent(connection: WebSocket, event: AgentRunEvent): void {
  if (connection.readyState !== connection.OPEN) {
    return;
  }

  connection.send(JSON.stringify(event));
}

async function enforceLlmRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  limiter: AuthenticatedFixedWindowRateLimiter,
): Promise<boolean> {
  const decision = await consumeLlmRateLimit(request, limiter);

  if (decision.allowed) {
    reply.header("x-ratelimit-limit", String(decision.limit));
    reply.header("x-ratelimit-remaining", String(decision.remaining));
    reply.header("x-ratelimit-reset", String(decision.resetAfterSeconds));
    return true;
  }

  reply.header("retry-after", String(decision.resetAfterSeconds));
  reply.header("x-ratelimit-limit", String(decision.limit));
  reply.header("x-ratelimit-remaining", "0");
  reply.header("x-ratelimit-reset", String(decision.resetAfterSeconds));
  reply.status(429).send({
    code: "rate_limit_exceeded",
    limit: decision.limit,
    message: `Too many LLM requests. Retry after ${String(decision.resetAfterSeconds)} seconds.`,
    remaining: 0,
    requestId: request.id,
    resetAfterSeconds: decision.resetAfterSeconds,
  });
  return false;
}

async function consumeLlmRateLimit(
  request: FastifyRequest,
  limiter: AuthenticatedFixedWindowRateLimiter,
) {
  const principal = requirePrincipal(request);

  return limiter.consume({
    routeGroup: "chat",
    tenantId: principal.tenantId,
    userId: principal.userId,
  });
}
