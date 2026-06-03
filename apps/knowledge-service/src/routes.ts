import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { badRequest, unauthorized } from "./errors.js";
import type { KnowledgeService } from "./knowledge-service.js";
import { DocumentParamsSchema, DocumentVisibilitySchema, SearchRequestSchema } from "./schemas.js";
import type { DocumentVisibility } from "./schemas.js";
import type { UploadDocumentInput } from "./types.js";

const MetadataSchema = z.record(z.string(), z.unknown());

interface ParsedMultipartUpload {
  buffer: Buffer;
  filename: string;
  fields: Record<string, string>;
  mimeType: string;
  sizeBytes: number;
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  knowledgeService: KnowledgeService,
  maxFileBytes: number,
) {
  app.post("/documents", { preHandler: app.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const upload = await parseMultipartUpload(request, maxFileBytes);
    const title = normalizeTitle(upload.fields.title, upload.filename);
    const visibility = parseVisibility(upload.fields.visibility);
    const metadata = parseMetadata(upload.fields.metadata);
    const mimeType = parseSupportedMimeType(upload.mimeType, upload.filename);

    const input: UploadDocumentInput = {
      buffer: upload.buffer,
      filename: upload.filename,
      metadata,
      mimeType,
      ownerId: principal.userId,
      sizeBytes: upload.sizeBytes,
      tenantId: principal.tenantId,
      title,
      visibility,
    };
    const response = await knowledgeService.uploadDocument(input, request.id);

    return reply.status(201).send(response);
  });

  app.get("/documents", { preHandler: app.authenticate }, async (request) => {
    const principal = requirePrincipal(request);
    const documents = await knowledgeService.listDocuments(principal.tenantId, principal.userId);

    return { documents };
  });

  app.delete("/documents/:documentId", { preHandler: app.authenticate }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const params = DocumentParamsSchema.parse(request.params);

    await knowledgeService.deleteDocument(
      params.documentId,
      principal.tenantId,
      principal.userId,
      request.id,
    );

    return reply.status(204).send();
  });

  app.post("/search", { preHandler: app.authenticate }, async (request) => {
    const principal = requirePrincipal(request);
    const body = SearchRequestSchema.parse(request.body);
    const results = await knowledgeService.search(
      body,
      principal.tenantId,
      principal.userId,
      request.id,
    );

    return { results };
  });
}

function requirePrincipal(request: FastifyRequest) {
  if (!request.principal) {
    throw unauthorized();
  }

  return request.principal;
}

async function parseMultipartUpload(
  request: FastifyRequest,
  maxFileBytes: number,
): Promise<ParsedMultipartUpload> {
  if (!request.isMultipart()) {
    throw badRequest("Request must be multipart/form-data");
  }

  const fields: Record<string, string> = {};
  let file:
    | {
        buffer: Buffer;
        filename: string;
        mimeType: string;
        sizeBytes: number;
      }
    | undefined;

  for await (const part of request.parts({
    limits: {
      fields: 10,
      fileSize: maxFileBytes,
      files: 1,
      parts: 12,
    },
  })) {
    if (part.type === "file") {
      if (file) {
        throw badRequest("Only one file can be uploaded per request");
      }

      const buffer = await part.toBuffer();

      file = {
        buffer,
        filename: part.filename,
        mimeType: part.mimetype,
        sizeBytes: buffer.length,
      };
      continue;
    }

    const value = typeof part.value === "string" ? part.value : String(part.value ?? "");
    fields[part.fieldname] = value;
  }

  if (!file) {
    throw badRequest("Missing file field");
  }

  if (file.sizeBytes === 0) {
    throw badRequest("Uploaded file is empty");
  }

  if (file.sizeBytes > maxFileBytes) {
    throw badRequest("Uploaded file exceeds the configured size limit");
  }

  return {
    ...file,
    fields,
  };
}

function parseSupportedMimeType(
  mimeType: string,
  filename: string,
): "application/pdf" | "text/plain" {
  const lowerFilename = filename.toLowerCase();

  if (mimeType === "application/pdf" && lowerFilename.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (
    mimeType === "text/plain" &&
    (lowerFilename.endsWith(".txt") || lowerFilename.endsWith(".text"))
  ) {
    return "text/plain";
  }

  throw badRequest("Only PDF and TXT uploads are supported");
}

function normalizeTitle(title: string | undefined, filename: string): string {
  const rawTitle = title?.trim() || filename.replace(/\.[^.]+$/, "");
  const normalized = rawTitle.replace(/\s+/g, " ").trim();

  if (!normalized) {
    throw badRequest("Document title is required");
  }

  return normalized.slice(0, 180);
}

function parseVisibility(input: string | undefined): DocumentVisibility {
  return DocumentVisibilitySchema.parse(input?.trim() || "private");
}

function parseMetadata(input: string | undefined): Record<string, unknown> {
  if (!input?.trim()) {
    return {};
  }

  try {
    return MetadataSchema.parse(JSON.parse(input));
  } catch (error) {
    throw badRequest("metadata must be a valid JSON object", error);
  }
}
