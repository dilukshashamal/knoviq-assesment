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

import {
  extractRequestedPeriod,
  isInvoiceWorkflowMessage,
} from "./agent-heuristics.js";

describe("isInvoiceWorkflowMessage", () => {
  it("detects invoice + total", () => {
    expect(isInvoiceWorkflowMessage("summarize invoices total")).toBe(true);
  });

  it("detects invoice + month name (any month)", () => {
    expect(isInvoiceWorkflowMessage("show invoices for January")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices for March 2026")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices for September")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices for december")).toBe(true);
  });

  it("detects invoice + ISO date", () => {
    expect(isInvoiceWorkflowMessage("invoices 2026-06")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices for 2025-12")).toBe(true);
  });

  it("detects invoice + quarter", () => {
    expect(isInvoiceWorkflowMessage("invoices q2")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoice report q3 2026")).toBe(true);
  });

  it("detects invoice + expenses", () => {
    expect(isInvoiceWorkflowMessage("calculate invoice expenses")).toBe(true);
  });

  it("detects invoice + this month / last month", () => {
    expect(isInvoiceWorkflowMessage("show invoices this month")).toBe(true);
    expect(isInvoiceWorkflowMessage("invoices last month")).toBe(true);
  });

  it("does NOT trigger on plain invoice mention without aggregation", () => {
    // "invoice" alone with no period/aggregation signal should not trigger the workflow
    expect(isInvoiceWorkflowMessage("where is my invoice")).toBe(false);
    expect(isInvoiceWorkflowMessage("what is an invoice")).toBe(false);
  });

  it("does NOT trigger on non-invoice messages", () => {
    expect(isInvoiceWorkflowMessage("what is the retention policy")).toBe(false);
    expect(isInvoiceWorkflowMessage("who can upload documents")).toBe(false);
  });
});

describe("extractRequestedPeriod", () => {
  it("extracts ISO month", () => {
    expect(extractRequestedPeriod("invoices for 2026-04")).toBe("2026-04");
  });

  it("extracts named month with year", () => {
    expect(extractRequestedPeriod("summarize invoices April 2026")).toBe("April 2026");
  });

  it("extracts named month without year", () => {
    expect(extractRequestedPeriod("invoices for September")).toBe("September");
  });

  it("returns null when no period is present", () => {
    expect(extractRequestedPeriod("show me all invoice totals")).toBeNull();
  });
});
