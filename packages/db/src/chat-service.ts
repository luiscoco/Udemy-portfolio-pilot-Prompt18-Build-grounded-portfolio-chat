import { chatMessageSchema, chatPageQuerySchema, conversationCreateSchema, conversationSchema, type ChatSource } from '@portfolio-pilot/contracts';
import type { PrismaClient } from './generated/prisma/client.js';
import { requireOwner, type AuthenticatedOwner } from './repositories.js';
import { PortfolioError } from './portfolio-service.js';

export function chatService(db: PrismaClient, owner: AuthenticatedOwner) {
  const ownerId = requireOwner(owner);
  const dto = (row: { createdAt: Date; updatedAt: Date }) => conversationSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
  const messageDto = (row: { createdAt: Date }) => chatMessageSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
  async function get(id: string) {
    const row = await db.conversation.findFirst({ where: { id, ownerId } });
    if (!row) throw new PortfolioError(404, 'Resource not found.');
    return dto(row);
  }
  return {
    get,
    async create(input: unknown) {
      const data = conversationCreateSchema.parse(input);
      if (data.portfolioId && !await db.portfolio.findFirst({ where: { id: data.portfolioId, ownerId } })) throw new PortfolioError(404, 'Resource not found.');
      return dto(await db.conversation.create({ data: { ...data, ownerId } }));
    },
    async list(input: unknown) {
      const { limit, before } = chatPageQuerySchema.parse(input);
      const anchor = before ? await get(before) : null;
      const rows = await db.conversation.findMany({ where: { ownerId, ...(anchor ? { OR: [{ createdAt: { lt: new Date(anchor.createdAt) } }, { createdAt: new Date(anchor.createdAt), id: { lt: anchor.id } }] } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      return { conversations: rows.slice(0, limit).map(dto), nextBefore: rows.length > limit ? rows[limit - 1]!.id : null };
    },
    async messages(id: string, input: unknown) {
      await get(id);
      const { limit, before } = chatPageQuerySchema.parse(input);
      const anchor = before ? await db.chatMessage.findFirst({ where: { id: before, conversationId: id, conversation: { ownerId } } }) : null;
      if (before && !anchor) throw new PortfolioError(404, 'Resource not found.');
      const rows = await db.chatMessage.findMany({ where: { conversationId: id, conversation: { ownerId }, ...(anchor ? { sequence: { lt: anchor.sequence } } : {}) }, orderBy: { sequence: 'desc' }, take: limit + 1 });
      return { messages: rows.slice(0, limit).reverse().map(messageDto), nextBefore: rows.length > limit ? rows[limit - 1]!.id : null };
    },
    async append(id: string, input: { role: 'user' | 'assistant'; content: string; status: 'completed' | 'failed'; mode: 'mock' | 'claude' | null; instructionVersion: string | null; sources: ChatSource[] }) {
      // Ownership is checked again inside the transaction; no naked message-by-ID writes.
      return db.$transaction(async tx => {
        const changed = await tx.conversation.updateMany({ where: { id, ownerId }, data: { updatedAt: new Date() } });
        if (!changed.count) throw new PortfolioError(404, 'Resource not found.');
        return messageDto(await tx.chatMessage.create({ data: { ...input, conversationId: id } }));
      });
    }
  };
}
