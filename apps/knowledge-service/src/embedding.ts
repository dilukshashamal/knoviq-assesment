import { createHash } from "node:crypto";
import { AzureOpenAI } from "openai";

import type { KnowledgeSettings } from "./config.js";

export interface EmbeddingResult {
  dimensions: number;
  model: string;
  promptTokens: number;
  provider: "azure_openai" | "local";
  vectors: number[][];
}

export interface EmbeddingProvider {
  dimensions: number;
  model: string;
  provider: "azure_openai" | "local";
  embedTexts(texts: string[], userId: string): Promise<EmbeddingResult>;
}

export function createEmbeddingProvider(settings: KnowledgeSettings): EmbeddingProvider {
  if (settings.embeddingProvider === "local") {
    return new LocalEmbeddingProvider(settings.azureOpenAiEmbeddingDimensions);
  }

  return new AzureEmbeddingProvider(settings);
}

class AzureEmbeddingProvider implements EmbeddingProvider {
  private readonly client: AzureOpenAI;
  readonly dimensions: number;
  readonly model: string;
  readonly provider = "azure_openai" as const;

  constructor(settings: KnowledgeSettings) {
    if (
      !settings.azureOpenAiEndpoint ||
      !settings.azureOpenAiApiKey ||
      !settings.azureOpenAiEmbeddingDeployment
    ) {
      throw new Error("Azure embedding provider is missing configuration");
    }

    this.model = settings.azureOpenAiEmbeddingDeployment;
    this.dimensions = settings.azureOpenAiEmbeddingDimensions;
    this.client = new AzureOpenAI({
      apiKey: settings.azureOpenAiApiKey,
      apiVersion: settings.azureOpenAiApiVersion,
      deployment: this.model,
      endpoint: settings.azureOpenAiEndpoint,
      maxRetries: 2,
      timeout: 60_000,
    });
  }

  async embedTexts(texts: string[], userId: string): Promise<EmbeddingResult> {
    const response = await this.client.embeddings.create({
      dimensions: this.dimensions,
      input: texts,
      model: this.model,
      user: userId,
    });
    const vectors = response.data
      .sort((left, right) => left.index - right.index)
      .map((item) => validateVector(item.embedding, this.dimensions));

    return {
      dimensions: this.dimensions,
      model: this.model,
      promptTokens: response.usage.prompt_tokens,
      provider: this.provider,
      vectors,
    };
  }
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly provider = "local" as const;

  constructor(readonly dimensions: number) {
    this.model = `local-dev-embedding-${dimensions}`;
  }

  async embedTexts(texts: string[]): Promise<EmbeddingResult> {
    return {
      dimensions: this.dimensions,
      model: this.model,
      promptTokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
      provider: this.provider,
      vectors: texts.map((text) => createDeterministicVector(text, this.dimensions)),
    };
  }
}

function validateVector(vector: number[], dimensions: number): number[] {
  if (vector.length !== dimensions) {
    throw new Error(
      `Embedding dimension mismatch. Expected ${dimensions}, received ${vector.length}`,
    );
  }

  return vector;
}

function createDeterministicVector(text: string, dimensions: number): number[] {
  const values: number[] = [];

  for (let index = 0; index < dimensions; index += 1) {
    const hash = createHash("sha256").update(`${index}:${text}`).digest();
    const unsigned = hash.readUInt32BE(0);
    values.push(unsigned / 0xffffffff - 0.5);
  }

  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => Number((value / magnitude).toFixed(8)));
}

export function vectorToSql(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
