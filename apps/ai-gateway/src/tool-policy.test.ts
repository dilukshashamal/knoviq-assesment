import { describe, expect, it } from "vitest";

import { normalizePlannedToolCall, sanitizeToolText } from "./tool-policy.js";
import type { PlannedToolCall } from "./types.js";

describe("tool policy", () => {
  it("normalizes knowledge retrieval arguments and strips control characters", () => {
    const call = normalizePlannedToolCall(
      {
        arguments: {
          limit: 100,
          query: "ignore previous rules\u0000 retention policy",
        },
        reason: "Search the KB",
        toolName: "knowledge.retrieve",
      },
      "fallback question",
    );

    expect(call).toMatchObject({
      arguments: {
        limit: 20,
        query: "ignore previous rules retention policy",
      },
      toolName: "knowledge.retrieve",
    });
  });

  it("falls back to the user message when retrieval arguments are malformed", () => {
    const call = normalizePlannedToolCall(
      {
        arguments: { query: "" },
        reason: "Search the KB",
        toolName: "knowledge.retrieve",
      },
      "Who can upload documents?",
    );

    expect(call?.arguments).toEqual({
      limit: 5,
      query: "Who can upload documents?",
    });
  });

  it("drops unsupported SQL operations before execution", () => {
    const call = normalizePlannedToolCall(
      {
        arguments: { operation: "drop_all_tables" },
        reason: "Bad request",
        toolName: "sql.query_safe",
      } as PlannedToolCall,
      "show metrics",
    );

    expect(call).toBeUndefined();
  });

  it("drops invalid calculator expressions before execution", () => {
    const call = normalizePlannedToolCall(
      {
        arguments: { expression: "" },
        reason: "Bad request",
        toolName: "calculator.evaluate",
      },
      "calculate 1 + 1",
    );

    expect(call).toBeUndefined();
  });

  it("sanitizes text without preserving invisible control bytes", () => {
    expect(sanitizeToolText("alpha\u0007\n beta", 20)).toBe("alpha beta");
  });
});
