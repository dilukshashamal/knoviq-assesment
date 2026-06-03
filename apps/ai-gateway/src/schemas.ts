import { z } from "zod";

export const ChatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(8000),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
