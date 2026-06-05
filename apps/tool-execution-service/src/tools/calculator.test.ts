import { describe, expect, it } from "vitest";

import { CalculatorTool } from "./calculator.js";

const calculator = new CalculatorTool();
const ctx: import("../types.js").ToolExecutionContext = {
  accessToken: "",
  conversationId: "c1",
  requestId: "r1",
  tenantId: "t1",
  userId: "u1",
};

describe("CalculatorTool", () => {
  it("evaluates simple addition", async () => {
    const result = await calculator.execute({ expression: "1 + 2" }, ctx);
    expect(result.result).toBe(3);
  });

  it("evaluates chained arithmetic", async () => {
    const result = await calculator.execute({ expression: "10 * 3 + 5" }, ctx);
    expect(result.result).toBe(35);
  });

  it("respects operator precedence", async () => {
    const result = await calculator.execute({ expression: "2 + 3 * 4" }, ctx);
    expect(result.result).toBe(14);
  });

  it("handles parentheses", async () => {
    const result = await calculator.execute({ expression: "(2 + 3) * 4" }, ctx);
    expect(result.result).toBe(20);
  });

  it("handles exponentiation", async () => {
    const result = await calculator.execute({ expression: "2 ^ 10" }, ctx);
    expect(result.result).toBe(1024);
  });

  it("rounds to requested precision", async () => {
    const result = await calculator.execute({ expression: "1 / 3", precision: 4 }, ctx);
    expect(result.result).toBe(0.3333);
  });

  it("handles floating point", async () => {
    const result = await calculator.execute({ expression: "1250.50 + 849.50" }, ctx);
    expect(result.result).toBe(2100);
  });

  it("handles unary negation", async () => {
    const result = await calculator.execute({ expression: "-5 + 10" }, ctx);
    expect(result.result).toBe(5);
  });

  it("returns the original expression in output", async () => {
    const result = await calculator.execute({ expression: "42" }, ctx);
    expect(result.expression).toBe("42");
    expect(result.result).toBe(42);
  });

  it("throws on division by zero", async () => {
    await expect(calculator.execute({ expression: "10 / 0" }, ctx)).rejects.toThrow();
  });

  it("throws on unsupported characters", async () => {
    await expect(calculator.execute({ expression: "Math.random()" }, ctx)).rejects.toThrow();
  });
});
