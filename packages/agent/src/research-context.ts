import { chatSourceSchema, validatedSourceUrl, type ChatSource, type ChatMessage } from '@portfolio-pilot/contracts';
import type { PortfolioToolContext } from './tools/context.js';
import { createPortfolioTools } from './tools/portfolio-tools.js';
import { largestHolding } from '@portfolio-pilot/domain';

export async function retrieveLargestHolding(context: PortfolioToolContext, portfolioId: string | null) {
  const definitions = createPortfolioTools(context);
  const call = async (name: string, args: unknown) => {
    const result = await definitions.find(t => t.name === name)!.handler(args as never, undefined);
    if (result.isError) throw new Error('Authorized holding data unavailable.');
    return result.structuredContent as Record<string, any>;
  };
  const overview = await call('getPortfolioSummary', portfolioId ? { portfolioId } : {});
  const portfolios = portfolioId ? [overview.portfolio] : overview.portfolios.filter((p: { archived: boolean }) => !p.archived);
  const positions: { securityId: string; symbol: string; marketValue: string | null }[] = [];
  let pages = 0;
  if (overview.meta.truncated) return { largest: null, reason: 'Portfolio scope is truncated.' };
  for (const p of portfolios) {
    let offset: number | null = 0;
    do {
      if (++pages > 20) return { largest: null, reason: 'Holdings exceed the local context limit. Select a portfolio.' };
      const page = await call('listHoldings', { portfolioId: p.id, limit: 50, offset });
      positions.push(...page.holdings);
      offset = page.meta.page.nextOffset;
    } while (offset !== null);
  }
  const largest = largestHolding(positions);
  return { largest, reason: largest ? null : 'No open holdings, or missing/stale quotes prevent a complete market-value ranking.', calculation: 'domain.largestHolding: exact sum by security across scoped active portfolios' };
}

/** Per-run, bounded evidence registry populated ONLY after successful authorized tool reads. */
export function researchContext(tools: PortfolioToolContext) {
  const sources = new Map<string, ChatSource>();
  const observed: PortfolioToolContext = { ...tools, onResult(name, value) {
    tools.onResult?.(name, value);
    if (name !== 'getNewsArticle') return;
    const article = value.article as Record<string, unknown> | undefined;
    if (!article || sources.size >= 30) return;
    const url = typeof article.url === 'string' ? validatedSourceUrl(article.url) : null;
    const parsed = chatSourceSchema.safeParse({ articleId: article.id, title: article.title, url, publishedAt: article.publishedAt, isSynthetic: article.isSynthetic });
    if (parsed.success) sources.set(parsed.data.articleId, parsed.data);
  } };
  return { tools: observed, sources: () => [...sources.values()] };
}

/** Inputs are owner-scoped DB DTOs and an owner-bound tool context, not arbitrary request IDs. */
export async function buildResearchPrompt(context: PortfolioToolContext, portfolioId: string | null, history: ChatMessage[], content: string): Promise<string> {
  let scope: unknown = { activePortfolios: true };
  if (portfolioId) {
    const tool = createPortfolioTools(context).find(t => t.name === 'getPortfolioSummary')!;
    const result = await tool.handler({ portfolioId }, undefined);
    if (result.isError) throw new Error('Authorized portfolio scope unavailable.');
    scope = result.structuredContent;
  }
  // JSON encoding prevents delimiter breakouts. It is still data, never a policy boundary.
  const turns = history.filter(m => m.status === 'completed').slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  const ranking = /\blargest\b/i.test(content) ? await retrieveLargestHolding(context, portfolioId) : null;
  return JSON.stringify({ kind: 'untrusted_research_request_data', asOf: (context.now ?? (() => new Date()))().toISOString(), portfolioId, scope, ranking, history: turns, historyTruncated: history.length > 8 || history.some(m => m.content.length > 2000), request: content });
}
