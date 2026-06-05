import { describe, expect, it } from "vitest";

import { createTimer, createRequestId, estimateLlmCostUsd } from "./index.js";

// ── createTimer ───────────────────────────────────────────────────────────────

describe("createTimer", () => {
  it("returns a non-negative elapsed milliseconds value", () => {
    const timer = createTimer();
    const ms = timer.stop();
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("elapsed time increases when called later", async () => {
    const timer = createTimer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ms = timer.stop();
    expect(ms).toBeGreaterThanOrEqual(5);
  });

  it("stop() returns an integer (Math.round applied)", () => {
    const timer = createTimer();
    const ms = timer.stop();
    expect(Number.isInteger(ms)).toBe(true);
  });
});

// ── createRequestId ───────────────────────────────────────────────────────────

describe("createRequestId", () => {
  it("starts with the given prefix", () => {
    const id = createRequestId("req");
    expect(id.startsWith("req_")).toBe(true);
  });

  it("default prefix is 'req'", () => {
    const id = createRequestId();
    expect(id.startsWith("req_")).toBe(true);
  });

  it("uses custom prefix", () => {
    const id = createRequestId("ai-gateway");
    expect(id.startsWith("ai-gateway_")).toBe(true);
  });

  it("generates unique ids", () => {
    const ids = Array.from({ length: 20 }, () => createRequestId("req"));
    const unique = new Set(ids);
    expect(unique.size).toBe(20);
  });
});

// ── estimateLlmCostUsd ────────────────────────────────────────────────────────

const settings = { promptCostPer1kTokens: 0.001, completionCostPer1kTokens: 0.002 };

describe("estimateLlmCostUsd", () => {
  it("uses built-in gpt-4o-mini rates for matching deployment name", () => {
    const cost = estimateLlmCostUsd(
      { modelDeployment: "gpt-4o-mini", promptTokens: 1000, completionTokens: 1000 },
      settings,
    );
    // gpt-4o-mini: prompt=0.00015, completion=0.0006 per 1k
    expect(cost).toBeCloseTo(0.00075, 6);
  });

  it("uses built-in gpt-4o rates (16× more expensive than mini)", () => {
    const miniCost = estimateLlmCostUsd(
      { modelDeployment: "gpt-4o-mini", promptTokens: 1000, completionTokens: 1000 },
      settings,
    );
    const fullCost = estimateLlmCostUsd(
      { modelDeployment: "gpt-4o", promptTokens: 1000, completionTokens: 1000 },
      settings,
    );
    expect(fullCost!).toBeGreaterThan(miniCost!);
  });

  it("uses built-in text-embedding-3-small rate (zero completion cost)", () => {
    const cost = estimateLlmCostUsd(
      {
        modelDeployment: "text-embedding-3-small",
        promptTokens: 1000,
        completionTokens: 0,
      },
      settings,
    );
    // 0.00002 per 1k prompt tokens
    expect(cost).toBeCloseTo(0.00002, 7);
  });

  it("falls back to settings rates for unknown deployment", () => {
    const cost = estimateLlmCostUsd(
      { modelDeployment: "my-custom-model", promptTokens: 1000, completionTokens: 1000 },
      settings,
    );
    // settings: prompt=0.001, completion=0.002 per 1k
    expect(cost).toBeCloseTo(0.003, 6);
  });

  it("returns undefined when both rates are zero and deployment is unknown", () => {
    const cost = estimateLlmCostUsd(
      { modelDeployment: "unknown-model", promptTokens: 1000, completionTokens: 1000 },
      { promptCostPer1kTokens: 0, completionCostPer1kTokens: 0 },
    );
    expect(cost).toBeUndefined();
  });

  it("returns zero cost for zero tokens", () => {
    const cost = estimateLlmCostUsd(
      { modelDeployment: "gpt-4o-mini", promptTokens: 0, completionTokens: 0 },
      settings,
    );
    expect(cost).toBe(0);
  });

  it("deployment name match is case-insensitive substring", () => {
    const cost1 = estimateLlmCostUsd(
      { modelDeployment: "my-GPT-4O-MINI-deployment", promptTokens: 1000, completionTokens: 0 },
      settings,
    );
    const cost2 = estimateLlmCostUsd(
      { modelDeployment: "gpt-4o-mini", promptTokens: 1000, completionTokens: 0 },
      settings,
    );
    expect(cost1).toBeCloseTo(cost2!, 8);
  });
});
