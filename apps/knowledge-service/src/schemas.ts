import { z } from "zod";

export const DocumentVisibilitySchema = z.enum(["private", "tenant", "shared"]);

export const SearchRequestSchema = z.object({
  documentIds: z.array(z.string().uuid()).max(25).optional(),
  limit: z.coerce.number().int().positive().max(20).optional(),
  minSimilarity: z.coerce.number().min(-1).max(1).optional(),
  query: z.string().trim().min(1).max(4000),
});

export const DocumentParamsSchema = z.object({
  documentId: z.string().uuid(),
});

export type DocumentParams = z.infer<typeof DocumentParamsSchema>;
export type DocumentVisibility = z.infer<typeof DocumentVisibilitySchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
