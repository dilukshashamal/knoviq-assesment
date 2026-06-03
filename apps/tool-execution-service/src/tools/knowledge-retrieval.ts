import type { ToolSettings } from "../config.js";
import { badRequest } from "../errors.js";
import { KnowledgeRetrieveArgumentsSchema, type KnowledgeRetrieveArguments } from "../schemas.js";
import type { ToolExecutionContext, ToolHandler } from "../types.js";

export class KnowledgeRetrievalTool implements ToolHandler<KnowledgeRetrieveArguments> {
  definition = {
    description:
      "Retrieves relevant chunks from the user's uploaded knowledge base. Returns citation-ready document and chunk metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          maxLength: 4000,
        },
        documentIds: {
          type: "array",
          maxItems: 25,
          items: { type: "string", format: "uuid" },
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
        },
        minSimilarity: {
          type: "number",
          minimum: -1,
          maximum: 1,
        },
      },
    },
    name: "knowledge.retrieve" as const,
  };

  constructor(private readonly settings: ToolSettings) {}

  async execute(args: KnowledgeRetrieveArguments, context: ToolExecutionContext) {
    const parsed = KnowledgeRetrieveArgumentsSchema.parse(args);
    const response = await fetch(`${this.settings.knowledgeServiceUrl}/search`, {
      body: JSON.stringify(parsed),
      headers: {
        authorization: `Bearer ${context.accessToken}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(this.settings.defaultTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      throw badRequest(`Knowledge retrieval failed with HTTP ${response.status}`, text);
    }

    return response.json();
  }
}
