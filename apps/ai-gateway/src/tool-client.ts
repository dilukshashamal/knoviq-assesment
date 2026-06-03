import { createCacheKey, type CacheClient } from "@knoviq/cache";

import type { AiGatewaySettings } from "./config.js";
import { badRequest } from "./errors.js";
import type { ExecutedToolCall, PlannedToolCall, ToolDefinition } from "./types.js";

interface ToolExecuteResponse {
  error?: {
    code: string;
    message: string;
  };
  executionId: string;
  latencyMs: number;
  output?: unknown;
  status: "succeeded" | "failed";
  toolName: string;
}

export class ToolExecutionClient {
  constructor(
    private readonly settings: AiGatewaySettings,
    private readonly cache: CacheClient,
  ) {}

  async getTools(accessToken: string): Promise<ToolDefinition[]> {
    const cacheKey = createCacheKey("ai-gateway:tool-definitions", {
      serviceUrl: this.settings.toolExecutionServiceUrl,
    });
    const cachedTools = await this.cache.getJson<ToolDefinition[]>(cacheKey);

    if (cachedTools) {
      return cachedTools;
    }

    const response = await fetch(`${this.settings.toolExecutionServiceUrl}/tools`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      method: "GET",
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw badRequest(
        `Failed to fetch tool definitions: HTTP ${response.status}`,
        await response.text(),
      );
    }

    const body = (await response.json()) as { tools?: ToolDefinition[] };
    const tools = body.tools ?? [];
    await this.cache.setJson(cacheKey, tools, this.settings.toolDefinitionsCacheTtlSeconds);
    return tools;
  }

  async executeTool(input: {
    accessToken: string;
    conversationId: string;
    messageId?: string;
    toolCall: PlannedToolCall;
  }): Promise<ExecutedToolCall> {
    const response = await fetch(`${this.settings.toolExecutionServiceUrl}/tools/execute`, {
      body: JSON.stringify({
        arguments: input.toolCall.arguments,
        conversationId: input.conversationId,
        messageId: input.messageId,
        toolName: input.toolCall.toolName,
      }),
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      return {
        arguments: input.toolCall.arguments,
        error: {
          code: "tool_http_error",
          message: `Tool service returned HTTP ${response.status}: ${await response.text()}`,
        },
        reason: input.toolCall.reason,
        status: "failed",
        toolName: input.toolCall.toolName,
      };
    }

    const body = (await response.json()) as ToolExecuteResponse;

    const result: ExecutedToolCall = {
      arguments: input.toolCall.arguments,
      executionId: body.executionId,
      latencyMs: body.latencyMs,
      reason: input.toolCall.reason,
      status: body.status,
      toolName: input.toolCall.toolName,
    };

    if (body.error !== undefined) {
      result.error = body.error;
    }

    if (body.output !== undefined) {
      result.output = body.output;
    }

    return result;
  }
}
