/**
 * Tests for the pure functions that are most likely to regress:
 *  - isInvoiceWorkflowMessage (the generalized version)
 *  - extractRequestedPeriod
 *  - applyValidationGuardrail (via the exported helpers in a future refactor)
 *
 * The AgentRunner class itself depends on external services, so we test
 * its internal logic by importing the module and calling the functions
 * through the compiled module boundary using the private-export trick.
 *
 * For now we test the logic indirectly via buildFollowUpToolCalls by
 * providing mock toolCall arrays.
 */
import { describe, expect, it } from "vitest";

// Re-export helpers for testing via a thin test-only re-export shim
// (avoids making internals public in prod code)
import { testIsInvoiceWorkflow, testExtractRequestedPeriod } from "./agent-runner-testexports.js";

describe("isInvoiceWorkflowMessage", () => {
  it("detects invoice + total", () => {
    expect(testIsInvoiceWorkflow("summarize invoices total")).toBe(true);
  });

  it("detects invoice + month name (any month)", () => {
    expect(testIsInvoiceWorkflow("show invoices for January")).toBe(true);
    expect(testIsInvoiceWorkflow("invoices for March 2026")).toBe(true);
    expect(testIsInvoiceWorkflow("invoices for September")).toBe(true);
    expect(testIsInvoiceWorkflow("invoices for december")).toBe(true);
  });

  it("detects invoice + ISO date", () => {
    expect(testIsInvoiceWorkflow("invoices 2026-06")).toBe(true);
    expect(testIsInvoiceWorkflow("invoices for 2025-12")).toBe(true);
  });

  it("detects invoice + quarter", () => {
    expect(testIsInvoiceWorkflow("invoices q2")).toBe(true);
    expect(testIsInvoiceWorkflow("invoice report q3 2026")).toBe(true);
  });

  it("detects invoice + expenses", () => {
    expect(testIsInvoiceWorkflow("calculate invoice expenses")).toBe(true);
  });

  it("detects invoice + this month / last month", () => {
    expect(testIsInvoiceWorkflow("show invoices this month")).toBe(true);
    expect(testIsInvoiceWorkflow("invoices last month")).toBe(true);
  });

  it("does NOT trigger on plain invoice mention without aggregation", () => {
    // "invoice" alone with no period/aggregation signal should not trigger the workflow
    expect(testIsInvoiceWorkflow("where is my invoice")).toBe(false);
    expect(testIsInvoiceWorkflow("what is an invoice")).toBe(false);
  });

  it("does NOT trigger on non-invoice messages", () => {
    expect(testIsInvoiceWorkflow("what is the retention policy")).toBe(false);
    expect(testIsInvoiceWorkflow("who can upload documents")).toBe(false);
  });
});

describe("extractRequestedPeriod", () => {
  it("extracts ISO month", () => {
    expect(testExtractRequestedPeriod("invoices for 2026-04")).toBe("2026-04");
  });

  it("extracts named month with year", () => {
    expect(testExtractRequestedPeriod("summarize invoices April 2026")).toBe("April 2026");
  });

  it("extracts named month without year", () => {
    expect(testExtractRequestedPeriod("invoices for September")).toBe("September");
  });

  it("returns null when no period is present", () => {
    expect(testExtractRequestedPeriod("show me all invoice totals")).toBeNull();
  });
});
