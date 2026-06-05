import { describe, expect, it } from "vitest";

import { chunkDocument } from "./chunker.js";

function makeInput(text: string, targetChars = 400, overlapChars = 50) {
  return {
    chunkOverlapChars: overlapChars,
    chunkTargetChars: targetChars,
    extracted: {
      pageCount: 1,
      pages: [{ pageNumber: 1, text }],
      text,
    },
  };
}

describe("chunkDocument", () => {
  it("produces at least one chunk for non-empty text", () => {
    const chunks = chunkDocument(makeInput("Hello world. This is a test."));
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("short text fits in a single chunk", () => {
    const text = "Short document with one sentence.";
    const chunks = chunkDocument(makeInput(text, 1800, 250));
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toBe(text);
  });

  it("splits on markdown headings", () => {
    const text = [
      "# Section One",
      "Content of section one. More text here.",
      "## Section Two",
      "Content of section two. More text here.",
    ].join("\n");

    const chunks = chunkDocument(makeInput(text, 1800, 250));
    const hasHeading = chunks.some((c) => c.content.startsWith("# Section One"));
    expect(hasHeading).toBe(true);
  });

  it("splits on two consecutive blank lines", () => {
    const block1 = "First paragraph with enough words to matter.";
    const block2 = "Second paragraph separated by double blank line.";
    const text = `${block1}\n\n\n${block2}`;
    const chunks = chunkDocument(makeInput(text, 1800, 250));
    // Both blocks should be reachable from the chunks
    const combined = chunks.map((c) => c.content).join(" ");
    expect(combined).toContain("First paragraph");
    expect(combined).toContain("Second paragraph");
  });

  it("assigns sequential chunkIndex values", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence ${String(i + 1)}.`).join(" ");
    const chunks = chunkDocument(makeInput(text, 100, 20));
    chunks.forEach((chunk, idx) => {
      expect(chunk.chunkIndex).toBe(idx);
    });
  });

  it("sets contentHash for every chunk", () => {
    const chunks = chunkDocument(makeInput("Test document. Has two sentences."));
    for (const chunk of chunks) {
      expect(chunk.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("extracts keywords for BM25", () => {
    const text = "Invoice vendor payment amount approved. Invoice vendor total expenses approved.";
    const chunks = chunkDocument(makeInput(text, 1800, 250));
    const keywords = chunks.flatMap((c) => c.keywords ?? []);
    expect(keywords).toContain("invoice");
    expect(keywords).toContain("vendor");
  });

  it("does not produce chunks with only whitespace", () => {
    const text = "Real content here.\n\n\n\n   \n\nMore real content here.";
    const chunks = chunkDocument(makeInput(text, 1800, 250));
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("respects targetChars — splits long text into multiple chunks", () => {
    // Build text well over 200 chars using real sentences with punctuation
    const sentences = Array.from(
      { length: 20 },
      (_, i) => `This is sentence number ${String(i + 1)} in the test document.`,
    );
    const text = sentences.join(" ");
    // targetChars=200 is much smaller than the full text (~1060 chars)
    const chunks = chunkDocument(makeInput(text, 200, 20));
    expect(chunks.length).toBeGreaterThan(1);
  });
});
