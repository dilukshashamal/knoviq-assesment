import { AzureOpenAI } from "openai";
import { z } from "zod";
import { toolNames, type ToolName } from "@knoviq/ai";
import { createTimer } from "@knoviq/observability";

import type { AiGatewaySettings } from "./config.js";
import { badRequest } from "./errors.js";
import type {
  AnswerValidation,
  ConversationMessage,
  ExecutedToolCall,
  PlannedToolCall,
  ToolDefinition,
} from "./types.js";

const PlannedToolCallSchema = z.object({
  arguments: z.unknown(),
  reason: z.string().min(1).max(500),
  toolName: z.enum(toolNames),
});

const AnswerValidationSchema = z.object({
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string().min(1).max(500)).max(10),
  requiredCaveats: z.array(z.string().min(1).max(500)).max(5),
  status: z.enum(["grounded", "partially_grounded", "unsupported"]),
  supportedToolNames: z.array(z.enum(toolNames)).max(10),
});

export interface ModelUsage {
  completionTokens: number;
  latencyMs: number;
  modelDeployment: string;
  promptTokens: number;
}

export interface PlanResult {
  toolCalls: PlannedToolCall[];
  usage: ModelUsage;
}

export interface SynthesisResult {
  answer: string;
  usage: ModelUsage;
}

export interface ValidationResult extends AnswerValidation {
  usage: ModelUsage;
}

export interface AgentModel {
  plan(input: {
    memory: ConversationMessage[];
    tools: ToolDefinition[];
    userMessage: string;
  }): Promise<PlanResult>;
  synthesize(input: {
    memory: ConversationMessage[];
    toolCalls: ExecutedToolCall[];
    userMessage: string;
  }): Promise<SynthesisResult>;
  validate(input: {
    draftAnswer: string;
    requiresGroundedEvidence: boolean;
    toolCalls: ExecutedToolCall[];
    userMessage: string;
  }): Promise<ValidationResult>;
}

export function createAgentModel(settings: AiGatewaySettings): AgentModel {
  if (settings.modelProvider === "local") {
    return new LocalAgentModel();
  }

  return new AzureChatAgentModel(settings);
}

class AzureChatAgentModel implements AgentModel {
  private readonly client: AzureOpenAI;
  private readonly fastDeployment: string;
  private readonly reasoningDeployment: string;

  constructor(private readonly settings: AiGatewaySettings) {
    if (
      !settings.azureOpenAiEndpoint ||
      !settings.azureOpenAiApiKey ||
      !settings.azureOpenAiChatDeploymentFast
    ) {
      throw new Error("Azure chat model is missing configuration");
    }

    this.fastDeployment = settings.azureOpenAiChatDeploymentFast;
    this.reasoningDeployment =
      settings.azureOpenAiChatDeploymentReasoning ?? settings.azureOpenAiChatDeploymentFast;
    this.client = new AzureOpenAI({
      apiKey: settings.azureOpenAiApiKey,
      apiVersion: settings.azureOpenAiApiVersion,
      endpoint: settings.azureOpenAiEndpoint,
      maxRetries: 2,
      timeout: 60_000,
    });
  }

  async plan(input: {
    memory: ConversationMessage[];
    tools: ToolDefinition[];
    userMessage: string;
  }): Promise<PlanResult> {
    const timer = createTimer();
    const response = await this.client.chat.completions.create({
      messages: [
        {
          role: "system",
          content: [
            'You are Knoviq\'s tool planner. Return strict JSON only: {"toolCalls":[{"toolName":"...","arguments":{},"reason":"..."}]}.',
            '',
            'TOOL PLANNING RULES (follow in order):',
            '1. ALWAYS call "knowledge.retrieve" for ANY factual, informational, policy, procedure, or "who/what/when/how/why" question — even if it seems general. The knowledge base is the primary source of truth.',
            '   Examples that MUST trigger knowledge.retrieve:',
            '   - "who can upload documents?" → retrieve with query "who can upload documents"',
            '   - "what is the retention policy?" → retrieve with query "retention policy"',
            '   - "In AtlasIQ who can do X?" → retrieve with query "AtlasIQ who can do X"',
            '   - "summarize the policy" → retrieve with query "policy summary"',
            '2. Only SKIP knowledge.retrieve for pure greetings (hi, hello, thanks) or pure arithmetic.',
            '3. For knowledge retrieval, set "query" to the user\'s question reworded as a keyword search phrase.',
            '4. Use "calculator.evaluate" only when the user provides or requests numeric arithmetic.',
            '5. Use "sql.query_safe" only when the user requests platform usage metrics, document counts, or reports.',
            '6. Never invent tool names. Only use tools from the provided list.',
          ].join('\n'),
        },
        {
          role: "user",
          content: JSON.stringify({
            recentMessages: input.memory.slice(-8),
            tools: input.tools,
            userMessage: input.userMessage,
          }),
        },
      ],
      model: this.fastDeployment,
      response_format: { type: "json_object" },
      temperature: 0,
    });
    const content = response.choices.at(0)?.message.content;

    if (!content) {
      throw badRequest("Planner returned an empty response");
    }

    // Parse the raw JSON, then filter out any tool calls that fail individual
    // validation (e.g. unrecognised tool name) rather than throwing on the whole batch.
    let rawToolCalls: unknown[] = [];
    try {
      const parsed = JSON.parse(content) as { toolCalls?: unknown[] };
      rawToolCalls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
    } catch {
      throw badRequest("Planner returned invalid JSON");
    }

    const validToolCalls = rawToolCalls
      .map((tc) => PlannedToolCallSchema.safeParse(tc))
      .filter((r) => r.success)
      .map((r) => (r as { success: true; data: PlannedToolCall }).data);

    return {
      toolCalls: validToolCalls.slice(0, 5),
      usage: {
        completionTokens: response.usage?.completion_tokens ?? 0,
        latencyMs: timer.stop(),
        modelDeployment: this.fastDeployment,
        promptTokens: response.usage?.prompt_tokens ?? 0,
      },
    };
  }

  async synthesize(input: {
    memory: ConversationMessage[];
    toolCalls: ExecutedToolCall[];
    userMessage: string;
  }): Promise<SynthesisResult> {
    const timer = createTimer();
    const response = await this.client.chat.completions.create({
      max_tokens: this.settings.maxOutputTokens,
      messages: [
        {
          role: "system",
          content: [
            "You are Knoviq, an enterprise knowledge assistant.",
            "",
            "ANSWERING RULES:",
            "1. Your primary source of truth is the knowledge base. When retrieved chunks are provided, base your entire answer on them.",
            "2. Cite sources: for each factual claim, reference the document title and chunk.",
            "3. If knowledge.retrieve returned chunks that answer the question, answer directly and concisely using only that content.",
            "4. If knowledge.retrieve returned chunks but none are relevant to the specific question, say: 'The uploaded documents do not contain information about [topic].'",
            "5. If no tool results were provided, answer only for pure greetings or arithmetic. For any other question, say you need to search the knowledge base first.",
            "6. NEVER fabricate facts, policies, numbers, or names not present in the retrieved chunks.",
            "7. Format: direct answer first → brief evidence from chunks → citations (Document: ..., Section: ...) → limitations if any.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            userMessage: input.userMessage,
            recentMessages: input.memory.slice(-6),
            retrievedChunks: input.toolCalls
              .filter((tc) => tc.toolName === "knowledge.retrieve" && tc.status === "succeeded")
              .flatMap((tc) => {
                const out = tc.output as { results?: Array<{ chunkContent: string; documentTitle: string; chunkId: string; score?: number }> } | undefined;
                return (
                  out?.results?.map((r, i) => ({
                    index: i + 1,
                    document: r.documentTitle,
                    chunkId: r.chunkId,
                    score: r.score,
                    content: r.chunkContent,
                  })) ?? []
                );
              }),
            otherToolResults: input.toolCalls
              .filter((tc) => tc.toolName !== "knowledge.retrieve")
              .map((tc) => ({
                toolName: tc.toolName,
                status: tc.status,
                output: tc.status === "succeeded" ? tc.output : undefined,
                error: tc.status === "failed" ? tc.error : undefined,
              })),
          }),
        },
      ],
      model: this.reasoningDeployment,
      temperature: 0.1,
    });

    return {
      answer:
        response.choices.at(0)?.message.content?.trim() || "I could not generate a response.",
      usage: {
        completionTokens: response.usage?.completion_tokens ?? 0,
        latencyMs: timer.stop(),
        modelDeployment: this.reasoningDeployment,
        promptTokens: response.usage?.prompt_tokens ?? 0,
      },
    };
  }

  async validate(input: {
    draftAnswer: string;
    requiresGroundedEvidence: boolean;
    toolCalls: ExecutedToolCall[];
    userMessage: string;
  }): Promise<ValidationResult> {
    const timer = createTimer();

    // Summarise what the knowledge tool actually returned (if anything)
    // Use 600 chars per chunk so the validator sees enough content to verify claims.
    const knowledgeChunks = input.toolCalls
      .filter((tc) => tc.toolName === "knowledge.retrieve" && tc.status === "succeeded")
      .flatMap((tc) => {
        const out = tc.output as { results?: Array<{ chunkContent: string; documentTitle: string }> } | undefined;
        return out?.results?.map((r) => `[${r.documentTitle}]: ${r.chunkContent.slice(0, 600)}`) ?? [];
      });

    const response = await this.client.chat.completions.create({
      messages: [
        {
          role: "system",
          content: [
            'You are Knoviq\'s answer validator and knowledge-base guardrail.',
            'Return STRICT JSON only:',
            '{"status":"grounded|partially_grounded|unsupported","confidence":0-1,"issues":[],"requiredCaveats":[],"supportedToolNames":[]}',
            '',
            'VALIDATION RULES:',
            '1. GROUNDED: Every factual claim in the answer appears verbatim or by paraphrase in the provided tool outputs.',
            '2. PARTIALLY_GROUNDED: Most claims are grounded but some are inferred or generalised.',
            '3. UNSUPPORTED: The answer contains claims NOT present in tool outputs, OR tool outputs were empty/missing when requiresGroundedEvidence=true.',
            '',
            'KNOWLEDGE-BASE BOUNDARY RULE (critical):',
            'If requiresGroundedEvidence=true AND the answer contains information that is NOT present in the retrieved chunks listed below, mark status as "unsupported".',
            'The assistant must NEVER answer from general LLM knowledge when the question is about uploaded documents.',
            '',
            'If requiresGroundedEvidence=false, allow general knowledge answers and mark as "grounded" if the answer is factually sound.',
          ].join('\n'),
        },
        {
          role: "user",
          content: JSON.stringify({
            userMessage: input.userMessage,
            draftAnswer: input.draftAnswer,
            requiresGroundedEvidence: input.requiresGroundedEvidence,
            retrievedChunks: knowledgeChunks,
            toolCallSummary: input.toolCalls.map((tc) => ({
              toolName: tc.toolName,
              status: tc.status,
              resultCount:
                tc.toolName === "knowledge.retrieve" && tc.status === "succeeded"
                  ? ((tc.output as { results?: unknown[] } | undefined)?.results?.length ?? 0)
                  : undefined,
            })),
          }),
        },
      ],
      model: this.fastDeployment,
      response_format: { type: "json_object" },
      temperature: 0,
    });
    const content = response.choices.at(0)?.message.content;

    if (!content) {
      throw badRequest("Validator returned an empty response");
    }

    const validation = AnswerValidationSchema.parse(JSON.parse(content));

    return {
      ...validation,
      usage: {
        completionTokens: response.usage?.completion_tokens ?? 0,
        latencyMs: timer.stop(),
        modelDeployment: this.fastDeployment,
        promptTokens: response.usage?.prompt_tokens ?? 0,
      },
    };
  }
}

class LocalAgentModel implements AgentModel {
  async plan(input: {
    memory: ConversationMessage[];
    tools: ToolDefinition[];
    userMessage: string;
  }): Promise<PlanResult> {
    const lower = input.userMessage.toLowerCase();
    const toolNamesAvailable = new Set(input.tools.map((tool) => tool.name));
    const toolCalls: PlannedToolCall[] = [];

    // The knowledge base is the primary source of truth for this assistant.
    // Retrieve for ALL questions except pure greetings and standalone arithmetic.
    // This ensures questions like "In AtlasIQ who can upload documents?" always
    // search the KB rather than being answered from LLM training data.
    const invoiceWorkflow = shouldUseInvoiceWorkflow(lower);
    const isPureGreeting = isPureConversationalGreeting(lower);
    const isPureArithmetic =
      !toolNamesAvailable.has("knowledge.retrieve") ||
      (extractArithmeticExpression(input.userMessage) !== undefined && lower.split(" ").length < 5);
    const shouldRetrieve =
      toolNamesAvailable.has("knowledge.retrieve") && !isPureGreeting && !isPureArithmetic;

    if (shouldRetrieve) {
      toolCalls.push({
        arguments: {
          limit: 5,
          // For invoice workflows pass -1 so the service returns all relevant chunks
          // regardless of similarity score. For other queries omit minSimilarity to
          // let the knowledge service use its configured default (0.3).
          ...(invoiceWorkflow ? { minSimilarity: -1 } : {}),
          query: invoiceWorkflow
            ? buildInvoiceRetrievalQuery(input.userMessage)
            : input.userMessage,
        },
        reason: "Searching the knowledge base — it is the primary source of truth.",
        toolName: "knowledge.retrieve",
      });
    }

    if (toolNamesAvailable.has("sql.query_safe") && shouldUseSql(lower)) {
      toolCalls.push({
        arguments: {
          operation: pickSqlOperation(lower),
        },
        reason: "The user is asking for structured platform data.",
        toolName: "sql.query_safe",
      });
    }

    const expression = extractArithmeticExpression(input.userMessage);

    if (toolNamesAvailable.has("calculator.evaluate") && expression) {
      toolCalls.push({
        arguments: { expression, precision: 2 },
        reason: "The user provided a numeric expression.",
        toolName: "calculator.evaluate",
      });
    }

    return {
      toolCalls: toolCalls.slice(0, 4),
      usage: localUsage("local-planner", input.userMessage, JSON.stringify(toolCalls)),
    };
  }

  async synthesize(input: {
    memory: ConversationMessage[];
    toolCalls: ExecutedToolCall[];
    userMessage: string;
  }): Promise<SynthesisResult> {
    const successful = input.toolCalls.filter((tc) => tc.status === "succeeded");
    const failed = input.toolCalls.filter((tc) => tc.status === "failed");
    let answer: string;

    if (successful.length === 0 && failed.length === 0) {
      // No tools ran — only acceptable for pure greetings/arithmetic
      answer =
        "I'm here to help! Ask me anything about your uploaded knowledge documents and I'll search them for you.";
    } else {
      const knowledgeCalls = successful.filter((tc) => tc.toolName === "knowledge.retrieve");
      const knowledgeHasChunks = knowledgeCalls.some((tc) => knowledgeResultCount(tc.output) > 0);

      if (knowledgeCalls.length > 0 && !knowledgeHasChunks) {
        answer =
          "I searched your uploaded documents but did not find relevant content for your query. " +
          "The documents may not contain information about this topic, or try rephrasing your question.";
      } else {
        const sections = successful.map((tc) => summarizeToolOutput(tc));
        answer = sections.join("\n\n");
      }

      if (failed.length > 0) {
        const failNote = failed
          .map((tc) => `${tc.toolName}: ${tc.error?.message ?? "failed"}`)
          .join("; ");
        answer += `\n\n_Note: Some tools encountered errors: ${failNote}_`;
      }
    }

    return {
      answer: answer || "I could not find enough information to answer.",
      usage: localUsage("local-synthesizer", input.userMessage, answer),
    };
  }

  async validate(input: {
    draftAnswer: string;
    requiresGroundedEvidence: boolean;
    toolCalls: ExecutedToolCall[];
    userMessage: string;
  }): Promise<ValidationResult> {
    const needsEvidence = input.requiresGroundedEvidence;
    const successfulTools = input.toolCalls.filter((toolCall) => toolCall.status === "succeeded");
    const successfulKnowledge = successfulTools.filter(
      (toolCall) => toolCall.toolName === "knowledge.retrieve",
    );
    const knowledgeHasResults = successfulKnowledge.some((toolCall) =>
      knowledgeResultCount(toolCall.output),
    );
    let validation: AnswerValidation;

    if (needsEvidence && successfulKnowledge.length === 0) {
      validation = {
        confidence: 0.2,
        issues: ["The user asked for document-backed evidence, but no knowledge tool succeeded."],
        requiredCaveats: ["Say that no supporting document evidence was found."],
        status: "unsupported",
        supportedToolNames: successfulTools.map((toolCall) => toolCall.toolName),
      };
    } else if (needsEvidence && !knowledgeHasResults) {
      validation = {
        confidence: 0.35,
        issues: ["Knowledge retrieval ran but did not return supporting chunks."],
        requiredCaveats: [
          "The uploaded documents do not contain relevant information for this query.",
        ],
        status: "unsupported",
        supportedToolNames: successfulTools.map((toolCall) => toolCall.toolName),
      };
    } else if (knowledgeHasResults) {
      // We have grounded document evidence — high confidence
      validation = {
        confidence: 0.92,
        issues: [],
        requiredCaveats: [],
        status: "grounded",
        supportedToolNames: successfulTools.map((toolCall) => toolCall.toolName),
      };
    } else if (successfulTools.length > 0) {
      validation = {
        confidence: 0.85,
        issues: [],
        requiredCaveats: [],
        status: "grounded",
        supportedToolNames: successfulTools.map((toolCall) => toolCall.toolName),
      };
    } else {
      // No tools ran — general conversational answer
      validation = {
        confidence: 0.7,
        issues: [],
        requiredCaveats: [],
        status: "partially_grounded",
        supportedToolNames: [],
      };
    }

    return {
      ...validation,
      usage: localUsage("local-validator", input.userMessage, JSON.stringify(validation)),
    };
  }
}

/**
 * Returns true ONLY for bare greetings and acknowledgements that carry
 * no information need — these are the only messages that should NOT trigger
 * a knowledge base search.
 *
 * Everything else (who/what/when/how/why questions, policy queries, product
 * questions, topic questions, proper nouns, etc.) should search the KB first.
 */
function isPureConversationalGreeting(message: string): boolean {
  return /^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|ok|okay|sure|yes|no|bye|goodbye|see you|got it|understood|noted|great|cool|awesome)\s*[!.?]?\s*$/.test(
    message.trim(),
  );
}

// Keep shouldRetrieveKnowledge for any remaining direct callers (none after this refactor,
// but retained to avoid breaking compilation if referenced elsewhere).
function shouldRetrieveKnowledge(message: string): boolean {
  return !isPureConversationalGreeting(message);
}

// Kept for symmetry — now delegates to isPureConversationalGreeting
function isGeneralConversational(message: string): boolean {
  return isPureConversationalGreeting(message);
}

function shouldUseInvoiceWorkflow(message: string): boolean {
  return /\binvoices?\b/.test(message);
}

function buildInvoiceRetrievalQuery(message: string): string {
  const period = message.match(
    /\b(?:20\d{2}-(?:0?[1-9]|1[0-2])|January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+20\d{2})?\b/i,
  )?.[0];

  return ["invoice", "total due", "amount due", "vendor", period].filter(Boolean).join(" ");
}

function shouldUseSql(message: string): boolean {
  return /\b(count|how many|usage|tokens|cost|tool executions|recent tools|documents|metrics|latency|throughput|requests)\b/.test(
    message,
  );
}

function pickSqlOperation(message: string): string {
  if (/\b(metrics|latency|throughput|requests)\b/.test(message)) {
    return "service_metric_summary";
  }

  if (/\b(usage|tokens|cost)\b/.test(message)) {
    return "llm_usage_summary";
  }

  if (/\b(tool executions|recent tools)\b/.test(message)) {
    return "tool_execution_summary";
  }

  if (/\b(list|recent)\b/.test(message) && /\b(document|documents)\b/.test(message)) {
    return "list_documents";
  }

  return "document_count";
}

function extractArithmeticExpression(message: string): string | undefined {
  const direct = message.match(/[-+*/^().\d\s]{3,}/g)?.find((match) => /\d/.test(match));

  if (!direct) {
    return undefined;
  }

  const trimmed = direct.trim();
  return /[+\-*/^]/.test(trimmed) ? trimmed : undefined;
}

function localUsage(modelDeployment: string, prompt: string, completion: string): ModelUsage {
  return {
    completionTokens: Math.ceil(completion.length / 4),
    latencyMs: 0,
    modelDeployment,
    promptTokens: Math.ceil(prompt.length / 4),
  };
}

function summarizeToolOutput(toolCall: ExecutedToolCall): string {
  if (toolCall.toolName === "calculator.evaluate") {
    const output = toolCall.output as { expression?: string; result?: number };
    return `Calculation: ${output.expression ?? "expression"} = ${output.result ?? "unknown"}.`;
  }

  if (toolCall.toolName === "knowledge.retrieve") {
    return summarizeKnowledgeOutput(toolCall.output);
  }

  if (toolCall.toolName === "document.extract_invoice_fields") {
    return summarizeInvoiceExtractionOutput(toolCall.output);
  }

  if (toolCall.toolName === "sql.query_safe") {
    return `SQL tool result:\n${JSON.stringify(toolCall.output, null, 2)}`;
  }

  return `${toolCall.toolName} result:\n${JSON.stringify(toolCall.output, null, 2)}`;
}

function summarizeKnowledgeOutput(output: unknown): string {
  const parsed = z
    .object({
      results: z.array(
        z.object({
          chunkContent: z.string(),
          chunkId: z.string(),
          documentTitle: z.string(),
          score: z.number().optional(),
        }),
      ),
    })
    .safeParse(output);

  if (!parsed.success || parsed.data.results.length === 0) {
    return "Knowledge retrieval did not return relevant chunks.";
  }

  const lines: string[] = [];

  for (const [index, result] of parsed.data.results.entries()) {
    lines.push(`**[${index + 1}] ${result.documentTitle}**`);
    lines.push(result.chunkContent.trim());
    lines.push(`_Source: chunk ${result.chunkId.slice(0, 8)}${result.score !== undefined ? `, relevance ${(result.score * 100).toFixed(0)}%` : ""}_`);
    lines.push("");
  }

  return lines.join("\n");
}

function summarizeInvoiceExtractionOutput(output: unknown): string {
  const parsed = z
    .object({
      currency: z.string(),
      invoiceCount: z.number(),
      invoices: z.array(
        z.object({
          amount: z.number(),
          documentTitle: z.string().optional(),
          evidence: z.string().optional(),
          invoiceDate: z.string().optional(),
          invoiceNumber: z.string().optional(),
          vendor: z.string().optional(),
        }),
      ),
      period: z.string().nullable(),
      totalAmount: z.number(),
    })
    .safeParse(output);

  if (!parsed.success) {
    return `Invoice extraction result:\n${JSON.stringify(output, null, 2)}`;
  }

  if (parsed.data.invoiceCount === 0) {
    return `Invoice extraction did not find invoice totals for ${parsed.data.period ?? "the requested period"}.`;
  }

  const invoices = parsed.data.invoices
    .map((invoice, index) => {
      const label =
        invoice.invoiceNumber ?? invoice.vendor ?? invoice.documentTitle ?? `invoice ${index + 1}`;
      const date = invoice.invoiceDate ? `, date ${invoice.invoiceDate}` : "";

      return `${label}${date}: ${parsed.data.currency} ${invoice.amount.toFixed(2)}`;
    })
    .join("\n");

  return `Invoice extraction for ${parsed.data.period ?? "all retrieved invoices"}:\n${invoices}\nTotal: ${parsed.data.currency} ${parsed.data.totalAmount.toFixed(2)}`;
}

function knowledgeResultCount(output: unknown): number {
  const parsed = z
    .object({
      results: z.array(z.unknown()),
    })
    .safeParse(output);

  return parsed.success ? parsed.data.results.length : 0;
}

export function isToolName(value: string): value is ToolName {
  return (toolNames as readonly string[]).includes(value);
}
