import { z } from "zod";

const ToolSettingsSchema = z.object({
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().min(1).default("2025-04-01-preview"),
  AZURE_OPENAI_CHAT_DEPLOYMENT_FAST: z.string().optional(),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_AUDIENCE: z.string().min(1).default("knoviq-api"),
  JWT_ISSUER: z.string().min(1).default("knoviq-auth-service"),
  KNOWLEDGE_SERVICE_URL: z.string().url().default("http://127.0.0.1:4003"),
  TOOL_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TOOL_SQL_MAX_LIMIT: z.coerce.number().int().positive().max(100).default(50),
});

export interface ToolSettings {
  azureOpenAiApiKey: string | undefined;
  azureOpenAiApiVersion: string;
  azureOpenAiChatDeploymentFast: string | undefined;
  azureOpenAiEndpoint: string | undefined;
  defaultTimeoutMs: number;
  jwtAccessSecret: string;
  jwtAudience: string;
  jwtIssuer: string;
  knowledgeServiceUrl: string;
  sqlMaxLimit: number;
}

export function loadToolSettings(): ToolSettings {
  const parsed = ToolSettingsSchema.parse(process.env);

  return {
    azureOpenAiApiKey: parsed.AZURE_OPENAI_API_KEY,
    azureOpenAiApiVersion: parsed.AZURE_OPENAI_API_VERSION,
    azureOpenAiChatDeploymentFast: parsed.AZURE_OPENAI_CHAT_DEPLOYMENT_FAST,
    azureOpenAiEndpoint: parsed.AZURE_OPENAI_ENDPOINT,
    defaultTimeoutMs: parsed.TOOL_DEFAULT_TIMEOUT_MS,
    jwtAccessSecret: parsed.JWT_ACCESS_SECRET,
    jwtAudience: parsed.JWT_AUDIENCE,
    jwtIssuer: parsed.JWT_ISSUER,
    knowledgeServiceUrl: parsed.KNOWLEDGE_SERVICE_URL.replace(/\/$/, ""),
    sqlMaxLimit: parsed.TOOL_SQL_MAX_LIMIT,
  };
}
