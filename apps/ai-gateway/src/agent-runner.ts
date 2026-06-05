import type { ToolName } from "@knoviq/ai";
import { createDomainEvent, type EventPublisher } from "@knoviq/events";
import { estimateLlmCostUsd, runWithSpan } from "@knoviq/observability";

import type { AiGatewaySettings } from "./config.js";
import {
  extractRequestedPeriod as extractRequestedPeriodFromMessage,
  isInvoiceWorkflowMessage as isInvoiceWorkflowMessageFromMessage,
  isPureConversationalGreeting,
} from "./agent-heuristics.js";
import type { AgentModel, ModelUsage } from "./model.js";
import type { AiGatewayRepository } from "./repository.js";
import type { ToolExecutionClient } from "./tool-client.js";
import { normalizePlannedToolCalls } from "./tool-policy.js";
import type {
  AgentEventHandler,
  AgentRunResult,
  AnswerValidation,
  ExecutedToolCall,
  PlannedToolCall,
} from "./types.js";

export interface RunAgentInput {
  accessToken: string;
  conversationId?: string;
  emit?: AgentEventHandler;
  message: string;
  requestId: string;
  tenantId: string;
  userId: string;
}

export class AgentRunner {
  constructor(
    private readonly repository: AiGatewayRepository,
    private readonly model: AgentModel,
    private readonly toolClient: ToolExecutionClient,
    private readonly settings: AiGatewaySettings,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async listConversations(input: { tenantId: string; userId: string }): Promise<{
    conversations: Array<{
      id: string;
      title: string | null;
      lastMessageAt: string;
      createdAt: string;
    }>;
  }> {
    return this.repository.listConversations(input);
  }

  async getConversationMessages(input: {
    conversationId: string;
    tenantId: string;
    userId: string;
  }): Promise<{
    messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
  }> {
    await this.repository.assertConversationAccess(input);
    const messages = await this.repository.getRecentMessages({
      conversationId: input.conversationId,
      limit: 100,
      tenantId: input.tenantId,
    });
    return { messages };
  }

  async run(input: RunAgentInput): Promise<AgentRunResult> {
    await this.repository.ensureMembership(input.tenantId, input.userId);

    const shouldCreateConversation = input.conversationId === undefined;
    const conversationId =
      input.conversationId ??
      (await this.repository.createConversation({
        firstMessage: input.message,
        tenantId: input.tenantId,
        userId: input.userId,
      }));

    if (shouldCreateConversation) {
      await this.publishConversationCreated({
        conversationId,
        input,
      });
    }

    if (input.conversationId) {
      await this.repository.assertConversationAccess({
        conversationId,
        tenantId: input.tenantId,
        userId: input.userId,
      });
    }

    await input.emit?.({ data: { conversationId }, type: "conversation" });
    await input.emit?.({
      data: { agent: "conversation_manager", status: "completed" },
      type: "agent_step",
    });

    const userMessageId = await this.repository.addMessage({
      content: input.message,
      conversationId,
      role: "user",
      tenantId: input.tenantId,
      tokenCount: estimateTokens(input.message),
    });

    await input.emit?.({ data: { messageId: userMessageId, role: "user" }, type: "message" });
    await this.publishMessageCreated({
      conversationId,
      input,
      messageId: userMessageId,
      role: "user",
    });

    if (isPureConversationalGreeting(input.message)) {
      return this.respondToPureGreeting({
        conversationId,
        input,
      });
    }

    const memory = await this.repository.getRecentMessages({
      conversationId,
      limit: this.settings.memoryMaxMessages,
      tenantId: input.tenantId,
    });
    const tools = await this.toolClient.getTools(input.accessToken);
    await input.emit?.({
      data: { agent: "planner", status: "started" },
      type: "agent_step",
    });
    const plan = await runWithSpan({
      attributes: {
        "knoviq.agent.name": "planner",
        "knoviq.agent.phase": "tool_planning",
        "knoviq.conversation_id": conversationId,
        "knoviq.tenant_id": input.tenantId,
      },
      name: "agent.tool_planning",
      operation: () =>
        this.model.plan({
          memory,
          tools,
          userMessage: input.message,
        }),
    });

    // ── Mandatory retrieval safety net ────────────────────────────────────────
    // If the planner returned no tool calls AND the knowledge.retrieve tool is
    // available AND the message is not a pure greeting, inject a retrieval call.
    // This ensures the KB is always searched for informational questions,
    // regardless of what the planner decided.
    plan.toolCalls = normalizePlannedToolCalls(plan.toolCalls, input.message);

    const knowledgeTool = tools.find((t) => t.name === "knowledge.retrieve");
    const planHasRetrieval = plan.toolCalls.some((tc) => tc.toolName === "knowledge.retrieve");
    const isPureGreeting = isPureConversationalGreeting(input.message);

    if (knowledgeTool && !planHasRetrieval && !isPureGreeting) {
      plan.toolCalls.unshift({
        arguments: { limit: 5, query: input.message },
        reason: "Mandatory KB search: always search the knowledge base before answering.",
        toolName: "knowledge.retrieve",
      });
    }

    await this.recordUsage({
      conversationId,
      input,
      purpose: "tool_planning",
      usage: plan.usage,
    });
    await input.emit?.({
      data: {
        agent: "planner",
        status: "completed",
        toolCallCount: plan.toolCalls.length,
      },
      type: "agent_step",
    });

    const toolCalls: ExecutedToolCall[] = [];

    for (const toolCall of plan.toolCalls) {
      const result = await this.executeToolCall({
        accessToken: input.accessToken,
        conversationId,
        emit: input.emit,
        toolCall,
      });
      toolCalls.push(result);
    }

    for (let followUpStep = 0; followUpStep < 4; followUpStep += 1) {
      const chainedCalls = normalizePlannedToolCalls(
        buildFollowUpToolCalls(input.message, toolCalls),
        input.message,
      );

      if (chainedCalls.length === 0) {
        break;
      }

      for (const toolCall of chainedCalls) {
        const result = await this.executeToolCall({
          accessToken: input.accessToken,
          conversationId,
          emit: input.emit,
          toolCall,
        });
        toolCalls.push(result);
      }
    }

    await this.repository.recordToolMessage({
      conversationId,
      tenantId: input.tenantId,
      toolCalls,
    });

    await input.emit?.({
      data: { agent: "synthesizer", status: "started" },
      type: "agent_step",
    });
    const synthesis = await runWithSpan({
      attributes: {
        "knoviq.agent.name": "synthesizer",
        "knoviq.agent.phase": "answer_synthesis",
        "knoviq.conversation_id": conversationId,
        "knoviq.tenant_id": input.tenantId,
        "knoviq.tool_call_count": toolCalls.length,
      },
      name: "agent.answer_synthesis",
      operation: () =>
        this.model.synthesize({
          memory,
          toolCalls,
          userMessage: input.message,
        }),
    });
    await input.emit?.({
      data: { agent: "synthesizer", status: "completed" },
      type: "agent_step",
    });
    const requiresGroundedEvidence = shouldRequireGroundedEvidence(input.message, toolCalls);

    await input.emit?.({
      data: { agent: "validator", status: "started" },
      type: "agent_step",
    });
    const validation = await runWithSpan({
      attributes: {
        "knoviq.agent.name": "validator",
        "knoviq.agent.phase": "answer_validation",
        "knoviq.conversation_id": conversationId,
        "knoviq.tenant_id": input.tenantId,
        "knoviq.tool_call_count": toolCalls.length,
      },
      name: "agent.answer_validation",
      operation: () =>
        this.model.validate({
          draftAnswer: synthesis.answer,
          requiresGroundedEvidence,
          toolCalls,
          userMessage: input.message,
        }),
    });

    await this.recordUsage({
      conversationId,
      input,
      purpose: "validation",
      usage: validation.usage,
    });
    await input.emit?.({
      data: {
        confidence: validation.confidence,
        issues: validation.issues,
        status: validation.status,
      },
      type: "validation",
    });
    await input.emit?.({
      data: {
        agent: "validator",
        status: "completed",
        validationStatus: validation.status,
      },
      type: "agent_step",
    });

    const finalAnswer = applyValidationGuardrail(synthesis.answer, validation, {
      requiresGroundedEvidence,
      knowledgeHadResults: toolCalls.some(
        (tc) =>
          tc.toolName === "knowledge.retrieve" &&
          tc.status === "succeeded" &&
          Array.isArray((tc.output as { results?: unknown[] } | undefined)?.results) &&
          (tc.output as { results: unknown[] }).results.length > 0,
      ),
    });
    const assistantMessageId = await this.repository.addMessage({
      content: finalAnswer,
      conversationId,
      metadata: {
        draftAnswer: finalAnswer === synthesis.answer ? undefined : synthesis.answer,
        toolCalls,
        validation: {
          confidence: validation.confidence,
          issues: validation.issues,
          requiredCaveats: validation.requiredCaveats,
          status: validation.status,
          supportedToolNames: validation.supportedToolNames,
        },
      },
      modelDeployment: synthesis.usage.modelDeployment,
      role: "assistant",
      tenantId: input.tenantId,
      tokenCount: estimateTokens(synthesis.answer),
    });

    await this.recordUsage({
      conversationId,
      input,
      messageId: assistantMessageId,
      purpose: "answer_synthesis",
      usage: synthesis.usage,
    });
    // Persist chunk citations into message_citations table (best-effort, non-blocking)
    await this.repository.recordMessageCitations({
      messageId: assistantMessageId,
      tenantId: input.tenantId,
      toolCalls,
    });
    await this.publishMessageCreated({
      conversationId,
      input,
      messageId: assistantMessageId,
      role: "assistant",
    });

    const result: AgentRunResult = {
      answer: finalAnswer,
      assistantMessageId,
      conversationId,
      requiresGroundedEvidence,
      toolCalls,
      validation: stripValidationUsage(validation),
    };

    await this.publishAgentRunCompleted({
      assistantMessageId,
      conversationId,
      input,
      toolCalls,
      validation,
    });
    await input.emit?.({ data: result, type: "final" });

    return result;
  }

  private async respondToPureGreeting(input: {
    conversationId: string;
    input: RunAgentInput;
  }): Promise<AgentRunResult> {
    await input.input.emit?.({
      data: { agent: "small_talk", status: "completed" },
      type: "agent_step",
    });

    const finalAnswer =
      "Hi! I'm ready to help with your uploaded documents. Ask me a question when you're ready.";
    const validation: AnswerValidation = {
      confidence: 1,
      issues: [],
      requiredCaveats: [],
      status: "grounded",
      supportedToolNames: [],
    };
    const assistantMessageId = await this.repository.addMessage({
      content: finalAnswer,
      conversationId: input.conversationId,
      metadata: {
        validation,
      },
      role: "assistant",
      tenantId: input.input.tenantId,
      tokenCount: estimateTokens(finalAnswer),
    });

    await this.publishMessageCreated({
      conversationId: input.conversationId,
      input: input.input,
      messageId: assistantMessageId,
      role: "assistant",
    });

    const result: AgentRunResult = {
      answer: finalAnswer,
      assistantMessageId,
      conversationId: input.conversationId,
      requiresGroundedEvidence: false,
      toolCalls: [],
      validation,
    };

    await this.publishAgentRunCompleted({
      assistantMessageId,
      conversationId: input.conversationId,
      input: input.input,
      toolCalls: [],
      validation,
    });
    await input.input.emit?.({ data: result, type: "final" });

    return result;
  }

  private async executeToolCall(input: {
    accessToken: string;
    conversationId: string;
    emit: AgentEventHandler | undefined;
    toolCall: PlannedToolCall;
  }): Promise<ExecutedToolCall> {
    await input.emit?.({
      data: {
        agent: `tool_agent.${input.toolCall.toolName}`,
        arguments: input.toolCall.arguments,
        reason: input.toolCall.reason,
        toolName: input.toolCall.toolName,
      },
      type: "tool_start",
    });

    const result = await runWithSpan({
      attributes: {
        "knoviq.agent.name": `tool_agent.${input.toolCall.toolName}`,
        "knoviq.conversation_id": input.conversationId,
        "knoviq.tool_name": input.toolCall.toolName,
      },
      name: `agent.tool_call.${input.toolCall.toolName}`,
      operation: () =>
        this.toolClient.executeTool({
          accessToken: input.accessToken,
          conversationId: input.conversationId,
          toolCall: input.toolCall,
        }),
    });

    await input.emit?.({ data: result, type: "tool_result" });

    return result;
  }

  private async recordUsage(input: {
    conversationId: string;
    input: RunAgentInput;
    messageId?: string;
    purpose: "tool_planning" | "answer_synthesis" | "validation";
    usage: ModelUsage;
  }): Promise<void> {
    const estimatedCostUsd = estimateLlmCostUsd(
      {
        completionTokens: input.usage.completionTokens,
        modelDeployment: input.usage.modelDeployment,
        promptTokens: input.usage.promptTokens,
      },
      {
        completionCostPer1kTokens: this.settings.llmCompletionCostPer1kTokens,
        promptCostPer1kTokens: this.settings.llmPromptCostPer1kTokens,
      },
    );
    const provider: "azure_openai" | "local" =
      this.settings.modelProvider === "local" ? "local" : "azure_openai";
    const usageInput = {
      completionTokens: input.usage.completionTokens,
      conversationId: input.conversationId,
      latencyMs: input.usage.latencyMs,
      modelDeployment: input.usage.modelDeployment,
      promptTokens: input.usage.promptTokens,
      purpose: input.purpose,
      provider,
      requestId: input.input.requestId,
      tenantId: input.input.tenantId,
      userId: input.input.userId,
    };
    const usageWithCost =
      estimatedCostUsd === undefined ? usageInput : { ...usageInput, estimatedCostUsd };

    await this.repository.recordLlmUsage(
      input.messageId === undefined
        ? usageWithCost
        : { ...usageWithCost, messageId: input.messageId },
    );
    await this.eventPublisher.publish({
      event: createDomainEvent({
        data: {
          completionTokens: input.usage.completionTokens,
          conversationId: input.conversationId,
          estimatedCostUsd: estimatedCostUsd ?? null,
          latencyMs: input.usage.latencyMs,
          messageId: input.messageId ?? null,
          modelDeployment: input.usage.modelDeployment,
          promptTokens: input.usage.promptTokens,
          purpose: input.purpose,
          provider,
        },
        eventType: "llm.usage.recorded",
        requestId: input.input.requestId,
        serviceName: "ai-gateway",
        tenantId: input.input.tenantId,
        userId: input.input.userId,
      }),
      key: input.conversationId,
      topic: "llm-usage",
    });
  }

  private async publishConversationCreated(input: {
    conversationId: string;
    input: RunAgentInput;
  }): Promise<void> {
    await this.eventPublisher.publish({
      event: createDomainEvent({
        data: {
          conversationId: input.conversationId,
        },
        eventType: "conversation.created",
        requestId: input.input.requestId,
        serviceName: "ai-gateway",
        tenantId: input.input.tenantId,
        userId: input.input.userId,
      }),
      key: input.conversationId,
      topic: "conversations",
    });
  }

  private async publishMessageCreated(input: {
    conversationId: string;
    input: RunAgentInput;
    messageId: string;
    role: "assistant" | "user";
  }): Promise<void> {
    await this.eventPublisher.publish({
      event: createDomainEvent({
        data: {
          conversationId: input.conversationId,
          messageId: input.messageId,
          role: input.role,
        },
        eventType: "conversation.message.created",
        requestId: input.input.requestId,
        serviceName: "ai-gateway",
        tenantId: input.input.tenantId,
        userId: input.input.userId,
      }),
      key: input.conversationId,
      topic: "conversations",
    });
  }

  private async publishAgentRunCompleted(input: {
    assistantMessageId: string;
    conversationId: string;
    input: RunAgentInput;
    toolCalls: ExecutedToolCall[];
    validation: AnswerValidation;
  }): Promise<void> {
    await this.eventPublisher.publish({
      event: createDomainEvent({
        data: {
          assistantMessageId: input.assistantMessageId,
          conversationId: input.conversationId,
          toolCallCount: input.toolCalls.length,
          toolStatuses: input.toolCalls.map((toolCall) => ({
            status: toolCall.status,
            toolName: toolCall.toolName,
          })),
          validationConfidence: input.validation.confidence,
          validationStatus: input.validation.status,
        },
        eventType: "agent.run.completed",
        requestId: input.input.requestId,
        serviceName: "ai-gateway",
        tenantId: input.input.tenantId,
        userId: input.input.userId,
      }),
      key: input.conversationId,
      topic: "agent-runs",
    });
  }
}

function applyValidationGuardrail(
  answer: string,
  validation: AnswerValidation,
  options: { requiresGroundedEvidence: boolean; knowledgeHadResults: boolean },
): string {
  if (!options.requiresGroundedEvidence) {
    return answer;
  }

  if (validation.status === "grounded") {
    return answer;
  }

  // If the knowledge base returned real chunks, the synthesizer's answer is
  // based on actual document content. Trust it even if the validator is uncertain.
  // Only block when there were genuinely no results to ground the answer on.
  if (options.knowledgeHadResults) {
    if (validation.status === "partially_grounded") {
      return answer; // good enough — don't add noise
    }
    // unsupported but we have chunks: add a soft caveat, don't replace
    const caveats = validation.requiredCaveats.length
      ? validation.requiredCaveats
      : ["Some claims in this answer may extend beyond the retrieved document content."];
    return `${answer}\n\n_Note: ${caveats.join(" ")}_`;
  }

  // No knowledge results at all
  if (validation.status === "partially_grounded") {
    const caveats = validation.requiredCaveats.length
      ? validation.requiredCaveats
      : ["Some parts of this answer have limited supporting evidence."];
    return `${answer}\n\n_Validation note: ${caveats.join(" ")}_`;
  }

  // Truly unsupported with no document evidence
  const caveat =
    validation.requiredCaveats.at(0) ??
    "I could not find relevant information in your uploaded documents to answer this question.";
  const issue = validation.issues.at(0) ?? "The answer was not supported by available evidence.";

  return `${caveat}\n\n_Details: ${issue}_`;
}

function stripValidationUsage(
  validation: AnswerValidation & { usage?: ModelUsage },
): AnswerValidation {
  return {
    confidence: validation.confidence,
    issues: validation.issues,
    requiredCaveats: validation.requiredCaveats,
    status: validation.status,
    supportedToolNames: validation.supportedToolNames,
  };
}

function shouldRequireGroundedEvidence(
  userMessage: string,
  toolCalls: ExecutedToolCall[],
): boolean {
  // Require grounding only when the agent actually attempted to retrieve evidence.
  // Do NOT require it based on message keywords alone — that causes the guardrail
  // to fire when zero tools ran (e.g. planner returned empty), blocking valid answers.
  const knowledgeWasAttempted = toolCalls.some((tc) => tc.toolName === "knowledge.retrieve");

  if (knowledgeWasAttempted) {
    return true;
  }

  // Other tools (calculator, invoice extraction, SQL) also produce grounded output
  if (toolCalls.length > 0) {
    return true;
  }

  // No tools ran at all → no grounding requirement; the synthesizer will say
  // it couldn't find information rather than producing a hallucinated answer.
  return false;
}

function buildFollowUpToolCalls(
  userMessage: string,
  toolCalls: ExecutedToolCall[],
): PlannedToolCall[] {
  const lower = userMessage.toLowerCase();
  const invoiceWorkflow = isInvoiceWorkflowMessageFromMessage(lower);
  const hasInvoiceExtraction = toolCalls.some(
    (toolCall) => toolCall.toolName === "document.extract_invoice_fields",
  );
  const hasCalculator = toolCalls.some((toolCall) => toolCall.toolName === "calculator.evaluate");

  if (invoiceWorkflow && !hasInvoiceExtraction) {
    const chunks = extractKnowledgeChunks(toolCalls);

    if (chunks.length > 0) {
      const period = extractRequestedPeriodFromMessage(userMessage);
      return [
        {
          arguments:
            period === null
              ? { chunks, currency: "USD" }
              : {
                  chunks,
                  currency: "USD",
                  period,
                },
          reason:
            "Chained after retrieval to extract structured invoice fields before aggregation.",
          toolName: "document.extract_invoice_fields" satisfies ToolName,
        },
      ];
    }
  }

  if (invoiceWorkflow && hasInvoiceExtraction && !hasCalculator) {
    const expression = extractInvoiceExpression(toolCalls);

    if (expression) {
      return [
        {
          arguments: {
            expression,
            precision: 2,
          },
          reason: "Chained after invoice extraction to verify the calculated total.",
          toolName: "calculator.evaluate" satisfies ToolName,
        },
      ];
    }
  }

  // Do NOT fall back to extractAmountsFromKnowledge — scanning raw chunk text for
  // numbers picks up dates, page numbers, quantities and produces wrong totals.
  // Invoice totals must come from document.extract_invoice_fields only.
  return [];
}

function _isInvoiceWorkflowMessage(message: string): boolean {
  // Detect invoice workflow by the presence of invoice-related terms combined with
  // any aggregation/period intent signal. Month names are NOT hardcoded — the period
  // regex covers ISO dates (2026-04), any month name, and generic time words.
  const hasInvoiceTerm = /\binvoices?\b/.test(message);
  const hasAggregationIntent =
    /\b(month|summarize|summary|total|sum|calculate|expenses?|report|breakdown)\b/.test(message);
  const hasPeriodSignal =
    /\b(20\d{2}[-/]\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|quarter|ytd|this year|last year|last month|this month)\b/.test(
      message,
    );
  return hasInvoiceTerm && (hasAggregationIntent || hasPeriodSignal);
}

function _extractRequestedPeriod(message: string): string | null {
  const isoMonth = message.match(/\b20\d{2}-(?:0?[1-9]|1[0-2])\b/)?.[0];

  if (isoMonth) {
    return isoMonth;
  }

  const monthMatch = message.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+20\d{2})?\b/i,
  )?.[0];

  return monthMatch ?? null;
}

function extractKnowledgeChunks(toolCalls: ExecutedToolCall[]): Array<{
  chunkContent: string;
  chunkId?: string;
  documentId?: string;
  documentTitle?: string;
}> {
  const chunks: Array<{
    chunkContent: string;
    chunkId?: string;
    documentId?: string;
    documentTitle?: string;
  }> = [];

  for (const toolCall of toolCalls) {
    if (toolCall.toolName !== "knowledge.retrieve" || toolCall.status !== "succeeded") {
      continue;
    }

    const output = toolCall.output;

    if (!output || typeof output !== "object" || !("results" in output)) {
      continue;
    }

    const results = (output as { results?: unknown }).results;

    if (!Array.isArray(results)) {
      continue;
    }

    for (const result of results) {
      if (!result || typeof result !== "object") {
        continue;
      }

      const candidate = result as {
        chunkContent?: unknown;
        chunkId?: unknown;
        documentId?: unknown;
        documentTitle?: unknown;
      };

      if (typeof candidate.chunkContent !== "string") {
        continue;
      }

      chunks.push({
        chunkContent: candidate.chunkContent,
        ...(typeof candidate.chunkId === "string" ? { chunkId: candidate.chunkId } : {}),
        ...(typeof candidate.documentId === "string" ? { documentId: candidate.documentId } : {}),
        ...(typeof candidate.documentTitle === "string"
          ? { documentTitle: candidate.documentTitle }
          : {}),
      });
    }
  }

  return chunks.slice(0, 20);
}

function extractInvoiceExpression(toolCalls: ExecutedToolCall[]): string | undefined {
  let invoiceExtraction: ExecutedToolCall | undefined;

  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];

    if (
      toolCall?.toolName === "document.extract_invoice_fields" &&
      toolCall.status === "succeeded"
    ) {
      invoiceExtraction = toolCall;
      break;
    }
  }

  if (!invoiceExtraction?.output || typeof invoiceExtraction.output !== "object") {
    return undefined;
  }

  const output = invoiceExtraction.output as {
    expression?: unknown;
    totalAmount?: unknown;
  };

  // Always prefer totalAmount for the calculator — it uses the document's
  // authoritative grand total rather than a sum of potentially misextracted
  // per-invoice amounts from the expression field.
  if (typeof output.totalAmount === "number" && output.totalAmount > 0) {
    return String(output.totalAmount);
  }

  if (typeof output.expression === "string" && output.expression !== "0") {
    return output.expression;
  }

  return undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
