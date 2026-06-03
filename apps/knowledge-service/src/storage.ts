import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SaveUploadedFileInput {
  buffer: Buffer;
  checksum: string;
  documentId: string;
  filename: string;
  tenantId: string;
  uploadDir: string;
}

export async function saveUploadedFile(input: SaveUploadedFileInput): Promise<string> {
  const uploadRoot = path.resolve(input.uploadDir);
  const tenantDir = path.join(uploadRoot, input.tenantId, input.documentId);
  const safeFilename = sanitizeFilename(input.filename);
  const storedFilename = `${input.checksum.slice(0, 16)}-${safeFilename}`;
  const finalPath = path.join(tenantDir, storedFilename);

  await mkdir(tenantDir, { recursive: true });
  await writeFile(finalPath, input.buffer, { flag: "wx" });

  return path.relative(uploadRoot, finalPath).replaceAll("\\", "/");
}

export function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);

  return sanitized || "document";
}
