import type { Pool } from "@knoviq/database";

import type { ToolSettings } from "../config.js";
import { badRequest } from "../errors.js";
import type { ToolName } from "../schemas.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { CalculatorTool } from "./calculator.js";
import { InvoiceExtractionTool } from "./invoice-extraction.js";
import { KnowledgeRetrievalTool } from "./knowledge-retrieval.js";
import { SafeSqlTool } from "./safe-sql.js";

export class ToolRegistry {
  private readonly handlers: Map<ToolName, ToolHandler>;

  constructor(pool: Pool, settings: ToolSettings) {
    const tools = [
      new CalculatorTool(),
      new KnowledgeRetrievalTool(settings),
      new SafeSqlTool(pool, settings),
      new InvoiceExtractionTool(settings),
    ];

    this.handlers = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.handlers.values()].map((handler) => handler.definition);
  }

  getHandler(toolName: ToolName): ToolHandler {
    const handler = this.handlers.get(toolName);

    if (!handler) {
      throw badRequest(`Unsupported tool: ${toolName}`);
    }

    return handler;
  }
}
