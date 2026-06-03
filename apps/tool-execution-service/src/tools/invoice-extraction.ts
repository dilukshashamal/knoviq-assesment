/**
 * LLM-based Invoice Extraction Tool
 *
 * WHY LLM INSTEAD OF REGEX:
 * Regex works only for one specific document layout. Real-world invoices come in
 * dozens of formats — expense tables, PDFs with labelled fields, scanned documents,
 * multi-currency reports, receipts, purchase orders, etc. An LLM understands all of
 * these without any format-specific code.
 *
 * APPROACH:
 * 1. Send all chunk text to AZURE_OPENAI_CHAT_DEPLOYMENT_FAST in a single batch call.
 * 2. Ask it to return strict JSON: an array of invoice objects + a verified grand total.
 * 3. Validate the response with Zod.
 * 4. If the LLM call fails (network, quota, malformed JSON), fall back gracefully to
 *    the regex-based grand-total extractor so the pipeline never hard-fails.
 *
 * The LLM prompt is designed to:
 * - Work on ANY invoice format (table, labeled fields, narrative, multi-currency)
 * - Filter by the requested period automatically
 * - Return the grand total from the document's own summary section when present
 * - Never hallucinate — it is instructed to only return values it can see in the text
 */

import { AzureOpenAI } from "openai";
import { z } from "zod";

import type { ToolSettings } from "../config.js";
import { InvoiceExtractionArgumentsSchema, type InvoiceExtractionArguments } from "../schemas.js";
import type { ToolExecutionContext, ToolHandler } from "../types.js";

// ── Zod schema for the LLM's JSON response ────────────────────────────────────

const LlmInvoiceSchema = z.object({
  invoiceNumber: z.string().optional(),
  vendor:        z.string().optional(),
  invoiceDate:   z.string().optional(),   // YYYY-MM-DD preferred
  description:   z.string().optional(),   // what was bought / category
  amount:        z.number().positive(),   // net payable for this invoice
  currency:      z.string().default("USD"),
  approvalStatus: z.string().optional(), // "Approved", "Approved by manager", etc.
});

const LlmExtractionResponseSchema = z.object({
  invoices:    z.array(LlmInvoiceSchema).max(50),
  grandTotal:  z.number().nonnegative().optional(), // from document's own verified total line
  periodLabel: z.string().optional(),              // what period the LLM detected
});

type LlmInvoice = z.infer<typeof LlmInvoiceSchema>;

// ── ExtractedInvoice (returned in tool output) ────────────────────────────────

interface ExtractedInvoice {
  amount:          number;
  approvalStatus?: string;
  currency:        string;
  description?:    string;
  invoiceDate?:    string;
  invoiceNumber?:  string;
  vendor?:         string;
}

// ── Tool class ────────────────────────────────────────────────────────────────

export class InvoiceExtractionTool implements ToolHandler<InvoiceExtractionArguments> {
  definition = {
    description:
      "Extracts structured invoice fields from retrieved document chunks using an LLM. " +
      "Works with any invoice format — expense tables, labeled fields, receipts, PDFs. " +
      "Returns per-invoice details and an aggregated total for the requested period.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["chunks"],
      properties: {
        chunks: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["chunkContent"],
            properties: {
              chunkContent:  { type: "string", maxLength: 20000 },
              chunkId:       { type: "string", format: "uuid" },
              documentId:    { type: "string", format: "uuid" },
              documentTitle: { type: "string", maxLength: 300 },
            },
          },
        },
        currency: { type: "string", default: "USD", maxLength: 12 },
        period: {
          type: "string",
          description: "Requested reporting period, e.g. April, April 2026, 2026-04.",
          maxLength: 80,
        },
      },
    },
    name: "document.extract_invoice_fields" as const,
  };

  constructor(private readonly settings: ToolSettings) {}

  async execute(args: InvoiceExtractionArguments, _context: ToolExecutionContext) {
    const parsed = InvoiceExtractionArgumentsSchema.parse(args);

    // Combine all chunk text into one context block for the LLM
    const documentText = parsed.chunks
      .map((c, i) => `--- Chunk ${i + 1} ---\n${c.chunkContent}`)
      .join("\n\n");

    // Try LLM extraction first; fall back to regex grand-total if it fails
    const llmResult = await this.extractWithLlm(documentText, parsed.currency, parsed.period);

    const invoices = llmResult?.invoices ?? [];
    const summedTotal = roundCurrency(invoices.reduce((s, inv) => s + inv.amount, 0));

    // Use document's own grand total when available (most authoritative)
    const totalAmount =
      llmResult?.grandTotal !== undefined && llmResult.grandTotal >= summedTotal
        ? llmResult.grandTotal
        : summedTotal > 0
          ? summedTotal
          : (extractFallbackGrandTotal(documentText) ?? 0);

    return {
      currency:         parsed.currency,
      expression:       invoices.map((inv) => inv.amount).join(" + ") || "0",
      invoiceCount:     invoices.length,
      invoices,
      period:           llmResult?.periodLabel ?? parsed.period ?? null,
      skippedChunkCount: 0,
      totalAmount,
    };
  }

  // ── LLM extraction ──────────────────────────────────────────────────────────

  private async extractWithLlm(
    documentText: string,
    currency: string,
    period: string | undefined,
  ): Promise<{ invoices: ExtractedInvoice[]; grandTotal?: number; periodLabel?: string } | null> {
    if (
      !this.settings.azureOpenAiEndpoint ||
      !this.settings.azureOpenAiApiKey ||
      !this.settings.azureOpenAiChatDeploymentFast
    ) {
      // Azure not configured — fall back to regex grand-total only
      return null;
    }

    const client = new AzureOpenAI({
      apiKey:     this.settings.azureOpenAiApiKey,
      apiVersion: this.settings.azureOpenAiApiVersion,
      endpoint:   this.settings.azureOpenAiEndpoint,
      maxRetries: 1,
      timeout:    25_000,
    });

    const periodInstruction = period
      ? `Only include invoices that fall within the period: "${period}". If no period is mentioned on an invoice, include it.`
      : "Include all invoices found in the document.";

    const systemPrompt = [
      "You are a precise invoice data extractor.",
      "Extract all invoice line items from the document text below.",
      periodInstruction,
      "",
      "Return STRICT JSON only — no markdown, no explanation:",
      '{',
      '  "invoices": [',
      '    {',
      '      "invoiceNumber": "INV-001",        // optional — the invoice/reference number',
      '      "vendor": "Acme Corp",              // optional — who issued the invoice',
      '      "invoiceDate": "2026-04-15",        // optional — YYYY-MM-DD format',
      '      "description": "Cloud hosting",    // optional — what was purchased',
      '      "amount": 780.00,                  // REQUIRED — the final payable amount',
      '      "currency": "USD",                 // currency code',
      '      "approvalStatus": "Approved"       // optional — approval state if present',
      '    }',
      '  ],',
      '  "grandTotal": 6837.50,   // optional — use ONLY if the document has an explicit verified total line',
      '  "periodLabel": "April 2026"  // optional — the period you detected from the document',
      '}',
      "",
      "RULES:",
      "1. amount must be the FINAL payable amount per invoice — not a subtotal, tax line, or quantity.",
      "2. If the document has a grand total / verified total line, put it in grandTotal.",
      "3. Never invent data — only extract values clearly present in the text.",
      "4. If a field is not present in the text, omit it (do not guess).",
      "5. Amounts must be plain numbers — no currency symbols, no commas.",
    ].join("\n");

    try {
      const response = await client.chat.completions.create({
        model: this.settings.azureOpenAiChatDeploymentFast,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Extract invoices from this document text:\n\n${documentText.slice(0, 12000)}`,
          },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 2000,
      });

      const raw = response.choices.at(0)?.message.content;
      if (!raw) return null;

      const parsed = LlmExtractionResponseSchema.parse(JSON.parse(raw));

      const invoices: ExtractedInvoice[] = parsed.invoices.map((inv: LlmInvoice) => ({
        amount:          roundCurrency(inv.amount),
        currency:        inv.currency ?? currency,
        ...(inv.invoiceNumber  ? { invoiceNumber:  inv.invoiceNumber }  : {}),
        ...(inv.vendor         ? { vendor:         inv.vendor }         : {}),
        ...(inv.invoiceDate    ? { invoiceDate:    inv.invoiceDate }    : {}),
        ...(inv.description    ? { description:    inv.description }    : {}),
        ...(inv.approvalStatus ? { approvalStatus: inv.approvalStatus } : {}),
      }));

      return {
        invoices,
        ...(parsed.grandTotal !== undefined ? { grandTotal: roundCurrency(parsed.grandTotal) } : {}),
        ...(parsed.periodLabel !== undefined ? { periodLabel: parsed.periodLabel } : {}),
      };
    } catch {
      // LLM failed — caller will use fallback regex grand-total
      return null;
    }
  }
}

// ── Fallback: regex-only grand total extraction ───────────────────────────────
// Used when Azure OpenAI is not available or the LLM call fails.
// Only extracts the document-level total — does NOT try to parse line items.

function extractFallbackGrandTotal(text: string): number | undefined {
  const patterns = [
    /\b(?:grand\s+total|total\s+due|amount\s+due|invoice\s+total|balance\s+due|total\s+payable)\b\s*:?\s*(?:USD|US\$|\$)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
    /\btotal\s+approved\s+\w[\w\s]*?expenses?\s+([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:USD)?/gi,
    /\btotal\s+(?:expenses?|amount)\s*:?\s*(?:USD|US\$|\$)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
  ];

  const normalized = text.replace(/\s+/g, " ");
  const found: number[] = [];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const val = toAmount(match[1]);
      if (val !== undefined && val > 0) found.push(val);
    }
  }

  return found.length > 0 ? Math.max(...found) : undefined;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function roundCurrency(value: number): number {
  return Number(value.toFixed(2));
}

function toAmount(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const amount = Number(input.replace(/,/g, ""));
  return Number.isFinite(amount) ? roundCurrency(amount) : undefined;
}
