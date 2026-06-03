import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";

import { unauthorized } from "./errors.js";
import { ChatRequestSchema } from "./schemas.js";
import type { AgentRunner } from "./agent-runner.js";
import type { AgentRunEvent } from "./types.js";
import type { AiGatewaySettings } from "./config.js";
import { parseBearerToken, verifyAccessToken } from "./jwt.js";

const WebSocketAuthQuerySchema = z.object({
  accessToken: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
});

export function registerChatRoutes(
  app: FastifyInstance,
  agentRunner: AgentRunner,
  settings: AiGatewaySettings,
) {
  app.post("/chat", { preHandler: app.authenticate }, async (request) => {
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

  app.post("/chat/stream", { preHandler: app.authenticate }, async (request, reply) => {
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
      writeSse(reply, { data: "[DONE]", type: "final" });
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
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
}

function writeSse(reply: FastifyReply, event: AgentRunEvent): void {
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
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
  rawMessage: WebSocket.RawData;
  request: FastifyRequest;
}): Promise<void> {
  try {
    const principal = requirePrincipal(input.request);

    if (!input.request.accessToken) {
      throw unauthorized();
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
    writeWebSocketEvent(input.connection, { data: "[DONE]", type: "final" });
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
