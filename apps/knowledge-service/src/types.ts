import type { DocumentVisibility } from "./schemas.js";

export interface ExtractedDocumentText {
  pageCount?: number;
  pages: Array<{
    pageNumber?: number;
    text: string;
  }>;
  text: string;
}

export interface DocumentChunk {
  chunkIndex: number;
  content: string;
  contentHash: string;
  estimatedTokens: number;
  /** Top-frequency keywords extracted during chunking, stored for BM25 retrieval */
  keywords?: string[];
  sourcePageEnd?: number;
  sourcePageStart?: number;
}

export interface UploadDocumentInput {
  buffer: Buffer;
  filename: string;
  metadata: Record<string, unknown>;
  mimeType: "application/pdf" | "text/plain";
  ownerId: string;
  sizeBytes: number;
  tenantId: string;
  title: string;
  visibility: DocumentVisibility;
}

export interface UploadedDocumentResponse {
  chunkCount: number;
  documentId: string;
  filename: string;
  status: "ready";
  title: string;
  visibility: DocumentVisibility;
}

export interface DocumentSummary {
  chunkCount: number;
  createdAt: string;
  documentId: string;
  filename: string;
  processedAt: string | null;
  status: string;
  title: string;
  updatedAt: string;
  visibility: DocumentVisibility;
}

export interface SearchResult {
  chunkContent: string;
  chunkId: string;
  chunkIndex: number;
  documentId: string;
  documentTitle: string;
  metadata: Record<string, unknown>;
  score: number;
  sourcePageEnd?: number;
  sourcePageStart?: number;
}
