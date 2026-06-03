import { PDFParse } from "pdf-parse";

import { badRequest } from "./errors.js";
import type { ExtractedDocumentText } from "./types.js";

export async function extractDocumentText(
  buffer: Buffer,
  mimeType: "application/pdf" | "text/plain",
): Promise<ExtractedDocumentText> {
  if (mimeType === "text/plain") {
    const text = normalizeExtractedText(buffer.toString("utf8"));

    if (!text) {
      throw badRequest("Text file does not contain extractable text");
    }

    return {
      pages: [{ text }],
      text,
    };
  }

  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    const pages = result.pages
      .map((page) => ({
        pageNumber: page.num,
        text: normalizeExtractedText(page.text),
      }))
      .filter((page) => page.text.length > 0);
    const text = normalizeExtractedText(result.text);

    if (!text || pages.length === 0) {
      throw badRequest("PDF does not contain extractable text");
    }

    return {
      pageCount: result.total,
      pages,
      text,
    };
  } finally {
    await parser.destroy();
  }
}

export function normalizeExtractedText(input: string): string {
  return input
    .replaceAll("\0", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
