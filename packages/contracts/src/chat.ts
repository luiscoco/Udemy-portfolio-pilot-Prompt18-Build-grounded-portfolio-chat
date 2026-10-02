import { z } from 'zod';

export function validatedSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export const chatSourceSchema = z.object({
  articleId: z.string().min(1).max(128), title: z.string().max(500),
  url: z.string().max(2048).refine(value => validatedSourceUrl(value) !== null),
  publishedAt: z.iso.datetime(), isSynthetic: z.boolean()
}).strict();
export type ChatSource = z.infer<typeof chatSourceSchema>;
export const conversationCreateSchema = z.object({ title: z.string().trim().min(1).max(100).default('Portfolio research'), portfolioId: z.string().min(1).max(128).nullable().default(null) }).strict();
export const conversationSchema = z.object({ id: z.string(), title: z.string(), portfolioId: z.string().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export const chatMessageSchema = z.object({
  id: z.string(), conversationId: z.string(), role: z.enum(['user', 'assistant']), content: z.string().max(16000),
  status: z.enum(['completed', 'failed']), mode: z.enum(['mock', 'claude']).nullable(),
  instructionVersion: z.string().nullable(), sources: z.array(chatSourceSchema).max(30), createdAt: z.iso.datetime()
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export const chatMessageCreateSchema = z.object({ content: z.string().trim().min(1).max(2000) }).strict();
export const chatPageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), before: z.string().min(1).max(128).optional() }).strict();
export const conversationResultSchema = z.object({ conversation: conversationSchema });
export const conversationPageSchema = z.object({ conversations: z.array(conversationSchema), nextBefore: z.string().nullable() });
export const messagePageSchema = z.object({ messages: z.array(chatMessageSchema), nextBefore: z.string().nullable() });
export const chatTurnResultSchema = z.object({ messages: z.array(chatMessageSchema).length(2) });
