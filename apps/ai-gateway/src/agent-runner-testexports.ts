/**
 * Test-only re-exports of pure functions from agent-runner.
 * This file is NOT imported by production code — it exists solely so that
 * vitest can test internal logic without making those functions part of the
 * public module surface.
 */

// ── Inline copies of the pure functions under test ───────────────────────────
// We duplicate them here rather than exporting from agent-runner.ts to avoid
// accidentally making internal logic part of the public API.

export function testIsInvoiceWorkflow(message: string): boolean {
  const lower = message.toLowerCase();
  const hasInvoiceTerm = /\binvoices?\b/.test(lower);
  const hasAggregationIntent =
    /\b(month|summarize|summary|total|sum|calculate|expenses?|report|breakdown)\b/.test(lower);
  const hasPeriodSignal =
    /\b(20\d{2}[-/]\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|q[1-4]|quarter|ytd|this year|last year|last month|this month)\b/.test(
      lower,
    );
  return hasInvoiceTerm && (hasAggregationIntent || hasPeriodSignal);
}

export function testExtractRequestedPeriod(message: string): string | null {
  const isoMonth = message.match(/\b20\d{2}-(?:0?[1-9]|1[0-2])\b/)?.[0];
  if (isoMonth) return isoMonth;

  const monthMatch = message.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+20\d{2})?\b/i,
  )?.[0];

  return monthMatch ?? null;
}
