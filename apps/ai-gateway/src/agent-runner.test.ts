import { describe, expect, it, vi } from "vitest";
import type { EventPublisher } from "@knoviq/events";

import { AgentRunner } from "./agent-runner.js";
import { extractRequestedPeriod, isInvoiceWorkflowMessage } from "./agent-heuristics.js";
import type { AiGatewaySettings } from "./config.js";
import type { AgentModel } from "./model.js";
import type { AiGatewayRepository } from "./repository.js";
import type { ToolExecutionClient } from "./tool-client.js";

describe("isInvoiceWorkflowMessage", () => {
  it("detects invoice + total", () => {
    expect(isInvoiceWorkflowMessage("summarize invoices total")).toBe(true);
  });

  it("detects invoice + month name (any month)", () => {
    expect(isInvoiceWorkflowMessage("show invoices for January")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices for March 2026")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices for September")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices for december")).toBe(true);
  });

  it("detects invoice + ISO date", () => {
    expect(isInvoiceWorkflowMessage("invoices 2026-06")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices for 2025-12")).toBe(true);
  });

  it("detects invoice + quarter", () => {
    expect(isInvoiceWorkflowMessage("invoices q2")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoice report q3 2026")).toBe(true);
  });

  it("detects invoice + expenses", () => {
    expect(isInvoiceWorkflowMessage("calculate invoice expenses")).toBe(true);
  });

  it("detects invoice + this month / last month", () => {
    expect(isInvoiceWorkflowMessage("show invoices this month")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices last month")).toBe(true);
  });

  it("does NOT trigger on plain invoice mention without aggregation", () => {
    // "invoice" alone with no period/aggregation signal should not trigger the workflow
    expect(isInvoiceWorkflowMessage("where is my invoice")).toBe(false);
    expect(isInvoiceWorkflowMessage("what is an invoice")).toBe(false);
  });

  it("does NOT trigger on non-invoice messages", () => {
    expect(isInvoiceWorkflowMessage("what is the retention policy")).toBe(false);
    expect(isInvoiceWorkflowMessage("who can upload documents")).toBe(false);
  });
});

describe("extractRequestedPeriod", () => {
  it("extracts ISO month", () => {
    expect(extractRequestedPeriod("invoices for 2026-04")).toBe("2026-04");
  });

  it("extracts named month with year", () => {
    expect(extractRequestedPeriod("summarize invoices April 2026")).toBe("April 2026");
  });

  it("extracts named month without year", () => {
    expect(extractRequestedPeriod("invoices for September")).toBe("September");
  });

  it("returns null when no period is present", () => {
    expect(extractRequestedPeriod("show me all invoice totals")).toBeNull();
  });
});

describe("AgentRunner greeting fast path", () => {
  it("answers pure greetings without planner, tool, synthesis, or validation model calls", async () => {
    const repository = {
      addMessage: vi
        .fn()
        .mockResolvedValueOnce("user-message-id")
        .mockResolvedValueOnce("assistant-message-id"),
      assertConversationAccess: vi.fn(),
      createConversation: vi.fn().mockResolvedValue("conversation-id"),
      ensureMembership: vi.fn().mockResolvedValue(undefined),
      getRecentMessages: vi.fn(),
      recordLlmUsage: vi.fn(),
      recordMessageCitations: vi.fn(),
      recordToolMessage: vi.fn(),
    } as unknown as AiGatewayRepository;
    const model = {
      plan: vi.fn(),
      synthesize: vi.fn(),
      validate: vi.fn(),
    } as unknown as AgentModel;
    const toolClient = {
      executeTool: vi.fn(),
      getTools: vi.fn(),
    } as unknown as ToolExecutionClient;
    const eventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } satisfies EventPublisher;
    const runner = new AgentRunner(
      repository,
      model,
      toolClient,
      minimalSettings(),
      eventPublisher,
    );

    const result = await runner.run({
      accessToken: "token",
      message: "hi",
      requestId: "request-id",
      tenantId: "tenant-id",
      userId: "user-id",
    });

    expect(result.answer).toContain("Hi!");
    expect(result.toolCalls).toEqual([]);
    expect(model.plan).not.toHaveBeenCalled();
    expect(model.synthesize).not.toHaveBeenCalled();
    expect(model.validate).not.toHaveBeenCalled();
    expect(toolClient.getTools).not.toHaveBeenCalled();
    expect(repository.recordLlmUsage).not.toHaveBeenCalled();
  });
});

function minimalSettings(): AiGatewaySettings {
  return {
    azureOpenAiApiKey: undefined,
    azureOpenAiApiVersion: "2025-04-01-preview",
    azureOpenAiChatDeploymentFast: undefined,
    azureOpenAiChatDeploymentReasoning: undefined,
    azureOpenAiEndpoint: undefined,
    jwtAccessSecret: "x".repeat(32),
    jwtAudience: "knoviq-api",
    jwtIssuer: "knoviq-auth-service",
    llmCompletionCostPer1kTokens: 0,
    llmPromptCostPer1kTokens: 0,
    llmRateLimitMaxRequests: 30,
    llmRateLimitWindowSeconds: 60,
    maxOutputTokens: 1200,
    memoryMaxMessages: 12,
    modelProvider: "local",
    toolDefinitionsCacheTtlSeconds: 300,
    toolExecutionServiceUrl: "http://127.0.0.1:4004",
  };
}
