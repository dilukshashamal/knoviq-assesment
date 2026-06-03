import { z } from "zod";

const AiGatewaySettingsSchema = z.object({
  AI_GATEWAY_MODEL_PROVIDER: z.enum(["azure", "local"]).default("azure"),
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().min(1).default("2025-04-01-preview"),
  AZURE_OPENAI_CHAT_DEPLOYMENT_FAST: z.string().optional(),
  AZURE_OPENAI_CHAT_DEPLOYMENT_REASONING: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_AUDIENCE: z.string().min(1).default("knoviq-api"),
  JWT_ISSUER: z.string().min(1).default("knoviq-auth-service"),
  LLM_COMPLETION_COST_PER_1K_TOKENS: z.coerce.number().min(0).default(0),
  LLM_DEFAULT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1200),
  LLM_MEMORY_MAX_MESSAGES: z.coerce.number().int().positive().max(50).default(12),
  LLM_PROMPT_COST_PER_1K_TOKENS: z.coerce.number().min(0).default(0),
  TOOL_DEFINITIONS_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
  TOOL_EXECUTION_SERVICE_URL: z.string().url().default("http://127.0.0.1:4004"),
});

export interface AiGatewaySettings {
  azureOpenAiApiKey: string | undefined;
  azureOpenAiApiVersion: string;
  azureOpenAiChatDeploymentFast: string | undefined;
  azureOpenAiChatDeploymentReasoning: string | undefined;
  azureOpenAiEndpoint: string | undefined;
  jwtAccessSecret: string;
  jwtAudience: string;
  jwtIssuer: string;
  llmCompletionCostPer1kTokens: number;
  llmPromptCostPer1kTokens: number;
  maxOutputTokens: number;
  memoryMaxMessages: number;
  modelProvider: "azure" | "local";
  toolDefinitionsCacheTtlSeconds: number;
  toolExecutionServiceUrl: string;
}

export function loadAiGatewaySettings(): AiGatewaySettings {
  const parsed = AiGatewaySettingsSchema.parse(process.env);

  if (parsed.AI_GATEWAY_MODEL_PROVIDER === "azure") {
    const missingAzureValue =
      !parsed.AZURE_OPENAI_ENDPOINT ||
      !parsed.AZURE_OPENAI_API_KEY ||
      !parsed.AZURE_OPENAI_CHAT_DEPLOYMENT_FAST;

    if (missingAzureValue) {
      throw new Error(
        "Azure chat configuration is required unless AI_GATEWAY_MODEL_PROVIDER=local",
      );
    }
  }

  return {
    azureOpenAiApiKey: parsed.AZURE_OPENAI_API_KEY,
    azureOpenAiApiVersion: parsed.AZURE_OPENAI_API_VERSION,
    azureOpenAiChatDeploymentFast: parsed.AZURE_OPENAI_CHAT_DEPLOYMENT_FAST,
    azureOpenAiChatDeploymentReasoning: parsed.AZURE_OPENAI_CHAT_DEPLOYMENT_REASONING,
    azureOpenAiEndpoint: parsed.AZURE_OPENAI_ENDPOINT,
    jwtAccessSecret: parsed.JWT_ACCESS_SECRET,
    jwtAudience: parsed.JWT_AUDIENCE,
    jwtIssuer: parsed.JWT_ISSUER,
    llmCompletionCostPer1kTokens: parsed.LLM_COMPLETION_COST_PER_1K_TOKENS,
    llmPromptCostPer1kTokens: parsed.LLM_PROMPT_COST_PER_1K_TOKENS,
    maxOutputTokens: parsed.LLM_DEFAULT_MAX_OUTPUT_TOKENS,
    memoryMaxMessages: parsed.LLM_MEMORY_MAX_MESSAGES,
    modelProvider: parsed.AI_GATEWAY_MODEL_PROVIDER,
    toolDefinitionsCacheTtlSeconds: parsed.TOOL_DEFINITIONS_CACHE_TTL_SECONDS,
    toolExecutionServiceUrl: parsed.TOOL_EXECUTION_SERVICE_URL.replace(/\/$/, ""),
  };
}
