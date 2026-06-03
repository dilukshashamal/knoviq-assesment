import { createDomainEvent, type EventPublisher } from "@knoviq/events";
import { createTimer } from "@knoviq/observability";

import { AppError } from "./errors.js";
import type { ToolExecutionRepository } from "./repository.js";
import { ExecuteToolRequestSchema, type ExecuteToolRequest } from "./schemas.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";
import type { ToolRegistry } from "./tools/registry.js";

export class ToolExecutionService {
  constructor(
    private readonly repository: ToolExecutionRepository,
    private readonly registry: ToolRegistry,
    private readonly eventPublisher: EventPublisher,
  ) {}

  getToolDefinitions() {
    return this.registry.getDefinitions();
  }

  async executeTool(
    requestBody: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const request = ExecuteToolRequestSchema.parse(requestBody);
    const executionId = await this.repository.startExecution({
      arguments: request.arguments,
      conversationId: request.conversationId,
      messageId: request.messageId,
      requestId: context.requestId,
      tenantId: context.tenantId,
      toolName: request.toolName,
      userId: context.userId,
    });
    const timer = createTimer();

    try {
      const toolContext: ToolExecutionContext = { ...context };

      if (request.conversationId !== undefined) {
        toolContext.conversationId = request.conversationId;
      }

      if (request.messageId !== undefined) {
        toolContext.messageId = request.messageId;
      }

      const output = await this.executeValidatedTool(request, toolContext);
      const latencyMs = timer.stop();

      await this.repository.completeExecution({
        executionId,
        latencyMs,
        output,
        tenantId: context.tenantId,
      });
      await this.publishExecutionCompleted({
        context,
        executionId,
        latencyMs,
        request,
        status: "succeeded",
      });

      return {
        executionId,
        latencyMs,
        output,
        status: "succeeded",
        toolName: request.toolName,
      };
    } catch (error) {
      const latencyMs = timer.stop();
      const toolError = toToolError(error);

      await this.repository.failExecution({
        errorCode: toolError.code,
        errorMessage: toolError.message,
        executionId,
        latencyMs,
        tenantId: context.tenantId,
      });
      await this.publishExecutionCompleted({
        context,
        errorCode: toolError.code,
        executionId,
        latencyMs,
        request,
        status: "failed",
      });

      return {
        error: toolError,
        executionId,
        latencyMs,
        status: "failed",
        toolName: request.toolName,
      };
    }
  }

  private async executeValidatedTool(request: ExecuteToolRequest, context: ToolExecutionContext) {
    const handler = this.registry.getHandler(request.toolName);
    return handler.execute(request.arguments, context);
  }

  private async publishExecutionCompleted(input: {
    context: ToolExecutionContext;
    errorCode?: string;
    executionId: string;
    latencyMs: number;
    request: ExecuteToolRequest;
    status: "succeeded" | "failed";
  }): Promise<void> {
    await this.eventPublisher.publish({
      event: createDomainEvent({
        data: {
          conversationId: input.request.conversationId ?? null,
          errorCode: input.errorCode ?? null,
          executionId: input.executionId,
          latencyMs: input.latencyMs,
          messageId: input.request.messageId ?? null,
          status: input.status,
          toolName: input.request.toolName,
        },
        eventType: "tool.execution.completed",
        requestId: input.context.requestId,
        serviceName: "tool-execution-service",
        tenantId: input.context.tenantId,
        userId: input.context.userId,
      }),
      key: input.executionId,
      topic: "tool-executions",
    });
  }
}

function toToolError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: "tool_execution_failed",
      message: error.message,
    };
  }

  return {
    code: "tool_execution_failed",
    message: "Tool execution failed",
  };
}
