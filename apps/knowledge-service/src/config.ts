import { z } from "zod";

const KnowledgeSettingsSchema = z.object({
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().min(1).default("2025-04-01-preview"),
  AZURE_OPENAI_CHAT_DEPLOYMENT_FAST: z.string().optional(),
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z.string().optional(),
  AZURE_OPENAI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  AZURE_OPENAI_ENDPOINT: z.string().url().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_AUDIENCE: z.string().min(1).default("knoviq-api"),
  JWT_ISSUER: z.string().min(1).default("knoviq-auth-service"),
  KNOWLEDGE_CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).default(250),
  KNOWLEDGE_CHUNK_TARGET_CHARS: z.coerce.number().int().min(400).default(1800),
  KNOWLEDGE_EMBEDDING_PROVIDER: z.enum(["azure", "local"]).default("azure"),
  KNOWLEDGE_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  // How many candidates to surface before reranking (should be > searchLimit)
  KNOWLEDGE_RERANK_CANDIDATES: z.coerce.number().int().positive().max(40).default(24),
  // Set to false to skip LLM reranking (faster but lower precision)
  KNOWLEDGE_RERANK_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  KNOWLEDGE_SEARCH_LIMIT: z.coerce.number().int().positive().max(20).default(8),
  KNOWLEDGE_SEARCH_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.2),
  KNOWLEDGE_SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(60),
  KNOWLEDGE_UPLOAD_DIR: z.string().min(1).default("./data/uploads"),
});

export interface KnowledgeSettings {
  azureOpenAiApiKey: string | undefined;
  azureOpenAiApiVersion: string;
  azureOpenAiChatDeploymentFast: string | undefined;
  azureOpenAiEmbeddingDeployment: string | undefined;
  azureOpenAiEmbeddingDimensions: number;
  azureOpenAiEndpoint: string | undefined;
  chunkOverlapChars: number;
  chunkTargetChars: number;
  embeddingProvider: "azure" | "local";
  jwtAccessSecret: string;
  jwtAudience: string;
  jwtIssuer: string;
  maxFileBytes: number;
  rerankCandidates: number;
  rerankEnabled: boolean;
  searchLimit: number;
  searchCacheTtlSeconds: number;
  searchMinSimilarity: number;
  uploadDir: string;
}

export function loadKnowledgeSettings(): KnowledgeSettings {
  const parsed = KnowledgeSettingsSchema.parse(process.env);

  if (parsed.KNOWLEDGE_EMBEDDING_PROVIDER === "azure") {
    const missingAzureValue =
      !parsed.AZURE_OPENAI_ENDPOINT ||
      !parsed.AZURE_OPENAI_API_KEY ||
      !parsed.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;

    if (missingAzureValue) {
      throw new Error(
        "Azure embedding configuration is required unless KNOWLEDGE_EMBEDDING_PROVIDER=local",
      );
    }
  }

  if (parsed.KNOWLEDGE_CHUNK_OVERLAP_CHARS >= parsed.KNOWLEDGE_CHUNK_TARGET_CHARS) {
    throw new Error("KNOWLEDGE_CHUNK_OVERLAP_CHARS must be smaller than target chunk size");
  }

  return {
    azureOpenAiApiKey: parsed.AZURE_OPENAI_API_KEY,
    azureOpenAiApiVersion: parsed.AZURE_OPENAI_API_VERSION,
    azureOpenAiChatDeploymentFast: parsed.AZURE_OPENAI_CHAT_DEPLOYMENT_FAST,
    azureOpenAiEmbeddingDeployment: parsed.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    azureOpenAiEmbeddingDimensions: parsed.AZURE_OPENAI_EMBEDDING_DIMENSIONS,
    azureOpenAiEndpoint: parsed.AZURE_OPENAI_ENDPOINT,
    chunkOverlapChars: parsed.KNOWLEDGE_CHUNK_OVERLAP_CHARS,
    chunkTargetChars: parsed.KNOWLEDGE_CHUNK_TARGET_CHARS,
    embeddingProvider: parsed.KNOWLEDGE_EMBEDDING_PROVIDER,
    jwtAccessSecret: parsed.JWT_ACCESS_SECRET,
    jwtAudience: parsed.JWT_AUDIENCE,
    jwtIssuer: parsed.JWT_ISSUER,
    maxFileBytes: parsed.KNOWLEDGE_MAX_FILE_BYTES,
    rerankCandidates: parsed.KNOWLEDGE_RERANK_CANDIDATES,
    rerankEnabled: parsed.KNOWLEDGE_RERANK_ENABLED,
    searchLimit: parsed.KNOWLEDGE_SEARCH_LIMIT,
    searchCacheTtlSeconds: parsed.KNOWLEDGE_SEARCH_CACHE_TTL_SECONDS,
    searchMinSimilarity: parsed.KNOWLEDGE_SEARCH_MIN_SIMILARITY,
    uploadDir: parsed.KNOWLEDGE_UPLOAD_DIR,
  };
}
