import { buildResearchPrompt, ClaudePortfolioAgentService, MockPortfolioAgentService, PORTFOLIO_INSTRUCTION_VERSION, researchContext, type AgentService, type PortfolioToolContext } from '@portfolio-pilot/agent';
import { chatMessageCreateSchema, chatPageQuerySchema } from '@portfolio-pilot/contracts';
import { PortfolioError, type chatService } from '@portfolio-pilot/db';
import { parseServerConfig } from '@portfolio-pilot/config/server';
import { chatCoordinator, type RunCoordinator } from './chat-coordinator';

export function chatPage(request: Request) {
  return chatPageQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
}
export async function chatBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > 10000) throw new PortfolioError(400, 'Request too large.');
  // Bound chunked bodies as well, without buffering an arbitrary upload first.
  const reader = request.body?.getReader();
  if (!reader) throw new PortfolioError(400, 'Expected JSON.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 10000) { await reader.cancel(); throw new PortfolioError(400, 'Request too large.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runChatTurn(input: {
  ownerKey: string; conversationId: string; body: unknown; chat: ReturnType<typeof chatService>; tools: PortfolioToolContext;
  coordinator?: RunCoordinator; agentFactory?: (tools: PortfolioToolContext) => AgentService;
}) {
  const { content } = chatMessageCreateSchema.parse(input.body);
  const conversation = await input.chat.get(input.conversationId); // Foreign IDs fail before run admission.
  return (input.coordinator ?? chatCoordinator).execute(input.ownerKey, conversation.id, async signal => {
    const history = await input.chat.messages(conversation.id, { limit: 9 });
    signal.throwIfAborted();
    const user = await input.chat.append(conversation.id, { role: 'user', content, status: 'completed', mode: null, instructionVersion: null, sources: [] });
    const context = researchContext({ ...input.tools, signal });
    let answer = 'The assistant could not complete this answer. Please try again. No trades or changes were made.';
    let mode: 'mock' | 'claude' | null = null;
    let status: 'completed' | 'failed' = 'failed';
    try {
      const prompt = await buildResearchPrompt(context.tools, conversation.portfolioId, history.messages, content);
      const config = parseServerConfig(process.env);
      if (signal.aborted) throw new Error('Local time limit.');
      const agent = input.agentFactory?.(context.tools) ?? (config.AGENT_MODE === 'mock' ? new MockPortfolioAgentService(context.tools) : new ClaudePortfolioAgentService({ signal, tools: context.tools, apiKey: config.ANTHROPIC_API_KEY, modelId: config.AGENT_MODEL_ID!, workspaceDir: config.AGENT_WORKSPACE_DIR! }));
      const result = await agent.ask(prompt);
      if (signal.aborted || !result.answer.trim() || result.answer.length > 16000) throw new Error('Invalid answer size or local time limit.');
      answer = result.answer; mode = result.mode; status = 'completed';
    } catch { /* Fixed public failure, never raw SDK/provider errors or sensitive arguments. */ }
    const assistant = await input.chat.append(conversation.id, { role: 'assistant', content: answer, status, mode, instructionVersion: PORTFOLIO_INSTRUCTION_VERSION, sources: status === 'completed' ? context.sources() : [] });
    return { messages: [user, assistant] };
  });
}
