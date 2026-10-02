import { requireAuthorization } from '../../../../../lib/authorization';
import { portfolioResponse } from '../../../../../lib/portfolio-http';
import { chatBody, chatPage, runChatTurn } from '../../../../../lib/chat';
export const runtime = 'nodejs';
export function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return portfolioResponse(request, async () => {
    const { chat } = await requireAuthorization(request);
    return chat.messages((await context.params).conversationId, chatPage(request));
  });
}
export function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return portfolioResponse(request, async () => {
    const auth = await requireAuthorization(request);
    const result = await runChatTurn({ ownerKey: auth.user.id, conversationId: (await context.params).conversationId, body: await chatBody(request), chat: auth.chat, tools: auth.agentTools });
    await requireAuthorization(request); // Do not return private answer text after session invalidation.
    return result;
  }, 201);
}
