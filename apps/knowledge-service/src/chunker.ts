/**
 * Hybrid Chunker
 *
 * Strategy (three-tier, applied in order of priority):
 *
 * 1. STRUCTURAL splits — hard boundaries that always cut:
 *    - Markdown/text headings  (lines starting with #, or ALL-CAPS short lines)
 *    - Horizontal rules / page separators
 *    - Two or more consecutive blank lines
 *    These preserve document structure so that a heading always starts its own chunk.
 *
 * 2. SEMANTIC splits — sentence-aware sliding window within each structural section:
 *    - Sentences are delimited by `. `, `? `, `! `, or `\n`
 *    - Chunks grow until they approach `chunkTargetChars`; the split fires at the
 *      last complete sentence before that limit.
 *    - An overlap of `chunkOverlapChars` worth of sentences is prepended to the
 *      next chunk so that cross-sentence answers are never lost.
 *
 * 3. KEYWORD enrichment — each chunk's metadata carries a `keywords` array of the
 *    10 highest-TF tokens (stop-words removed). These are stored in the chunk
 *    `metadata` JSON column and used by the BM25 full-text search path at query time.
 *
 * References:
 *  - "Document Chunking for RAG: 9 Strategies" (langcopilot.com, 2026)
 *  - "Contextual Embeddings and Hybrid Search Fix Retrieval Failures" (freecodecamp.org, 2026)
 *  - "A 2026 Retrieval Playbook" (digitalapplied.com, 2026)
 */

import { createHash } from "node:crypto";

import type { DocumentChunk, ExtractedDocumentText } from "./types.js";

export interface ChunkDocumentInput {
  chunkOverlapChars: number;
  chunkTargetChars: number;
  extracted: ExtractedDocumentText;
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

export function chunkDocument(input: ChunkDocumentInput): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];

  for (const page of input.extracted.pages) {
    // Step 1: structural split into sections
    const sections = splitStructural(page.text);

    for (const section of sections) {
      if (!section.trim()) continue;

      // Step 2: semantic sliding window within each section
      const textChunks = splitSemantic(section, input.chunkTargetChars, input.chunkOverlapChars);

      for (const content of textChunks) {
        const trimmed = content.trim();
        if (!trimmed) continue;

        const chunk: DocumentChunk = {
          chunkIndex: chunks.length,
          content: trimmed,
          contentHash: sha256Hex(trimmed),
          estimatedTokens: estimateTokens(trimmed),
          // Step 3: keyword metadata for BM25 search
          keywords: extractKeywords(trimmed),
        };

        if (page.pageNumber !== undefined) {
          chunk.sourcePageStart = page.pageNumber;
          chunk.sourcePageEnd = page.pageNumber;
        }

        chunks.push(chunk);
      }
    }
  }

  return chunks;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 1 — Structural splitter
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Splits text at hard structural boundaries:
 *  - Markdown headings (#, ##, …)
 *  - ALL-CAPS short lines that look like section titles (≤ 80 chars)
 *  - Horizontal rules (--- / === / *** with optional spaces)
 *  - 2+ consecutive blank lines
 *
 * The heading/title line is prepended to the section that follows it so the
 * section always begins with its own heading (improves embedding quality).
 */
function splitStructural(text: string): string[] {
  const normalized = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\0", "");

  const lines = normalized.split("\n");
  const sections: string[] = [];
  let currentLines: string[] = [];
  let blankRun = 0;

  for (const line of lines) {
    const isBlank = /^\s*$/.test(line);
    const isHeading = /^#{1,6}\s/.test(line);
    const isTitleCase = /^[A-Z][A-Z0-9 .&'-]{3,79}$/.test(line.trim());
    const isHRule = /^[\s]*[-=*]{3,}[\s]*$/.test(line);

    if (isBlank) {
      blankRun += 1;
      if (blankRun >= 2 && currentLines.length > 0) {
        sections.push(currentLines.join("\n"));
        currentLines = [];
        blankRun = 0;
      } else {
        currentLines.push(line);
      }
      continue;
    }

    blankRun = 0;

    if ((isHeading || isTitleCase || isHRule) && currentLines.length > 0) {
      sections.push(currentLines.join("\n"));
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push(currentLines.join("\n"));
  }

  return sections.filter((s) => s.trim().length > 0);
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 2 — Semantic sliding-window splitter
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Splits a section into chunks that respect sentence boundaries.
 *
 * Algorithm:
 *  1. Tokenize text into sentences using `. `, `? `, `! `, `\n` as delimiters.
 *  2. Accumulate sentences into a window until adding the next one would exceed
 *     `targetChars`.
 *  3. Emit the window as a chunk.
 *  4. Slide forward: carry over the last N characters worth of sentences
 *     (overlap) into the next window.
 */
function splitSemantic(text: string, targetChars: number, overlapChars: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= targetChars) return [normalized];

  const sentences = tokenizeSentences(normalized);
  if (sentences.length === 0) return [normalized];

  const chunks: string[] = [];
  let windowStart = 0; // sentence index

  while (windowStart < sentences.length) {
    let charCount = 0;
    let windowEnd = windowStart;

    // Grow window until we'd exceed the target
    while (windowEnd < sentences.length) {
      const s = sentences[windowEnd] ?? "";
      if (charCount > 0 && charCount + s.length > targetChars) break;
      charCount += s.length + 1; // +1 for space separator
      windowEnd += 1;
    }

    // Always advance by at least one sentence to prevent infinite loops
    if (windowEnd === windowStart) windowEnd = windowStart + 1;

    const chunkText = sentences.slice(windowStart, windowEnd).join(" ").trim();
    if (chunkText) chunks.push(chunkText);

    // Slide forward: find the new start that keeps `overlapChars` of context
    let overlapCount = 0;
    let newStart = windowEnd - 1;

    while (newStart > windowStart) {
      const s = sentences[newStart - 1] ?? "";
      if (overlapCount + s.length > overlapChars) break;
      overlapCount += s.length + 1;
      newStart -= 1;
    }

    windowStart = Math.max(windowStart + 1, newStart);
  }

  return chunks;
}

/**
 * Naive sentence tokenizer.
 * Splits on `. `, `? `, `! ` followed by an uppercase letter or end of string,
 * and on newlines that end a line (i.e., list items / short paragraphs).
 * Keeps the delimiter attached to the preceding sentence.
 */
function tokenizeSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space+uppercase or newline
  const raw = text
    .split(/(?<=[.?!])\s+(?=[A-Z"'(])|(?<=\n)(?=\S)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // If the text is one giant block with no sentence breaks, fall back to
  // word-boundary splits at the target size
  if (raw.length === 1 && raw[0] && raw[0].length > 600) {
    return splitByWords(raw[0], 300);
  }

  return raw;
}

/** Last-resort word-boundary split for run-on text with no punctuation */
function splitByWords(text: string, approxChars: number): string[] {
  const words = text.split(/\s+/);
  const segments: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > approxChars && current) {
      segments.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }

  if (current) segments.push(current);
  return segments;
}

// ──────────────────────────────────────────────────────────────────────────────
// Step 3 — Keyword extraction for BM25 metadata
// ──────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","and","are","as","at","be","been","being","by","do","does","for",
  "from","had","has","have","he","her","his","how","i","if","in","is","it",
  "its","me","my","no","not","of","on","or","our","s","she","so","that","the",
  "their","them","then","there","these","they","this","to","us","was","we",
  "were","what","when","where","which","who","will","with","you","your",
]);

/**
 * Returns the top-10 most frequent non-stop tokens from the chunk text.
 * Stored in chunk metadata so Postgres `tsvector` search can use them.
 */
function extractKeywords(text: string): string[] {
  const freq = new Map<string, number>();

  for (const raw of text.toLowerCase().matchAll(/[a-z][a-z0-9'-]{2,}/g)) {
    const token = raw[0];
    if (!STOP_WORDS.has(token)) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([token]) => token);
}
