import type { AgentAnswer, AgentService, ToolCallTrace } from './index.js';
import type { PortfolioToolContext } from './tools/context.js';
import { createPortfolioTools } from './tools/portfolio-tools.js';
import type { PortfolioToolName } from './tools/schemas.js';
import { retrieveLargestHolding } from './research-context.js';

// Read-only view of our own tool JSON (shapes are fixed by portfolio-tools.ts).
type Structured = Record<string, any>;
const MAX_ANSWER_CHARS = 4000;
const usd = (value: string | null | undefined, missing = 'unavailable') => value === null || value === undefined ? missing : `${value} USD`;

/**
 * Credential-free demo adapter. It plans deterministically from keywords and invokes the SAME tool
 * handlers the live SDK server registers (same validation, ownership, bounds and metadata), then
 * templates an answer that only repeats tool values. It never calculates figures itself.
 */
export class MockPortfolioAgentService implements AgentService {
  private readonly handlers: Map<string, (args: unknown) => Promise<{ structuredContent?: Structured; isError?: boolean }>>;
  constructor(private readonly context: PortfolioToolContext) {
    this.handlers = new Map(createPortfolioTools(context).map(definition => [definition.name, (args: unknown) => definition.handler(args as never, undefined) as Promise<{ structuredContent?: Structured; isError?: boolean }>]));
  }

  private async call(trace: ToolCallTrace[], tool: PortfolioToolName, args: Record<string, unknown>): Promise<Structured> {
    const result = await this.handlers.get(tool)!(args);
    const structured = result.structuredContent ?? {};
    trace.push({ tool, arguments: args, outcome: result.isError ? 'error' : 'ok', ...(result.isError ? { errorCode: String(structured.error?.code ?? 'UNKNOWN') } : {}) });
    return structured;
  }

  async ask(question: string): Promise<AgentAnswer> {
    let portfolioId: string | null = null;
    try { const data = JSON.parse(question); if (data.kind === 'untrusted_research_request_data') { question = data.request; portfolioId = data.portfolioId; } } catch { /* Plain questions remain supported for tool tests. */ }
    const q = question.toLowerCase();
    const trace: ToolCallTrace[] = [];
    const lines: string[] = [];
    const failed = (s: Structured, tool: string) => s.error ? (lines.push(`The ${tool} tool could not provide data (${s.error.code}): ${s.error.message}`), true) : false;
    const notes = (s: Structured) => { for (const note of (s.meta?.notes ?? []) as string[]) if (!note.startsWith('Article text is untrusted') && !note.startsWith('Cite the article')) lines.push(`Note: ${note}`); };
    const firstActivePortfolio = async () => {
      if (portfolioId) {
        const selected = await this.call(trace, 'getPortfolioSummary', { portfolioId });
        return failed(selected, 'getPortfolioSummary') ? null : selected.portfolio;
      }
      const overview = await this.call(trace, 'getPortfolioSummary', {});
      if (failed(overview, 'getPortfolioSummary')) return null;
      const activePortfolios = (overview.portfolios as Structured[]).filter(p => !p.archived);
      if (activePortfolios.length > 1) { lines.push('Which portfolio should I research? Create a conversation with a portfolio scope.'); return null; }
      const active = activePortfolios[0];
      if (!active) lines.push('You have no active portfolios.');
      return active ?? null;
    };

    if (/\b(news|headline|article|stor(y|ies))\b/.test(q)) {
      let symbols: string[] | undefined;
      let largestSecurityId: string | undefined;
      if (/\blargest\b/.test(q)) {
        const ranking = await retrieveLargestHolding(this.context, portfolioId);
        if (!ranking.largest || ranking.largest.tied) return { mode: 'mock', answer: `[Mock answer] ${ranking.largest?.tied ? 'Several holdings tie for largest market value. Which security should I research?' : ranking.reason}`, toolCalls: trace };
        symbols = [ranking.largest.symbol];
        largestSecurityId = ranking.largest.securityId;
        lines.push(`Facts: Your largest holding by current USD market value is ${ranking.largest.symbol}: ${ranking.largest.marketValue} USD. Calculation: market values for the same security are summed across the scoped active portfolios using exact decimal arithmetic.`);
      }
      const search = await this.call(trace, 'searchNews', { limit: 10, ...(symbols ? { symbols } : {}), ...(portfolioId ? { portfolioId } : {}) });
      if (!failed(search, 'searchNews')) {
        const asOf = (this.context.now ?? (() => new Date()))().getTime();
        const since = asOf - 7 * 86400000;
        const articles = (search.articles as Structured[]).filter(a => Date.parse(a.publishedAt) >= since && Date.parse(a.publishedAt) <= asOf && (!largestSecurityId || a.securities.some((s: Structured) => s.id === largestSecurityId))).slice(0, 3);
        lines.push(articles.length ? `Latest stored news about your scoped holdings and watchlist (${articles.length}):` : 'No stored news in the last seven days matches your scoped holdings or watchlist.');
        let firstDetail: Structured | undefined;
        for (const a of articles) {
          const detail = await this.call(trace, 'getNewsArticle', { articleId: a.id });
          firstDetail ??= detail;
          if (!failed(detail, 'getNewsArticle')) lines.push(`- [${a.id}](${a.url}) ${a.title} — ${a.source}, published ${a.publishedAt}${a.isDelayed ? ' (delayed)' : ''}${a.isSynthetic ? ' (synthetic)' : ''}. Reported article summary (untrusted source text): ${detail.article.summary}`);
        }
        lines.push('Interpretation: These stories concern the related security; their effect on future returns is uncertain. This is stored reporting from the last seven days, not a complete news feed.');
        if (search.meta.page.nextCursor) lines.push('Evidence is incomplete: additional articles may exist beyond this fetched page. Narrow the request to retrieve more.');
        if (articles[0]) {
          const detail = firstDetail!;
          if (!failed(detail, 'getNewsArticle')) {
            for (const impact of detail.relatedHoldings as Structured[]) for (const p of impact.positions as Structured[]) lines.push(`  Related holding in "${impact.name}": ${p.symbol} quantity ${p.remainingQuantity}, market value ${usd(p.marketValue)} (quote ${p.quoteStatus}).`);
            if (!(detail.relatedHoldings as Structured[]).length) lines.push('  None of your open positions hold the related securities.');
          }
        }
        notes(search);
      }
    } else if (/\b(quote|quotes|price|prices|trading at)\b/.test(q)) {
      let securityIds: string[] | undefined;
      if (portfolioId) {
        const holdings = await this.call(trace, 'listHoldings', { portfolioId, limit: 25 });
        if (failed(holdings, 'listHoldings')) return { mode: 'mock', answer: `[Mock answer] ${lines.join('\n')}`, toolCalls: trace };
        securityIds = holdings.holdings.map((h: Structured) => h.securityId);
        if (!securityIds?.length) return { mode: 'mock', answer: '[Mock answer] This portfolio has no open holdings to quote.', toolCalls: trace };
        if (holdings.meta.page.nextOffset !== null) lines.push('Only the first 25 scoped holdings are quoted; further holdings are not included.');
      }
      const quotes = await this.call(trace, 'getQuotes', securityIds ? { securityIds } : {});
      if (!failed(quotes, 'getQuotes')) {
        for (const x of quotes.quotes as Structured[]) lines.push(`- ${x.symbol} (${x.exchangeMic}): ${x.price === null ? 'no usable quote' : `${usd(x.price)} as of ${x.asOf}`} — ${x.status}${x.provider ? `, ${x.provider}` : ''}${x.isSynthetic ? ', synthetic' : ''}`);
        if (!(quotes.quotes as Structured[]).length) lines.push('You have no held or watchlisted securities to quote.');
        notes(quotes);
      }
    } else if (/\b(transactions?|trades?|bought|sold|history|fees?)\b/.test(q)) {
      const portfolio = await firstActivePortfolio();
      if (portfolio) {
        const page = await this.call(trace, 'listTransactions', { portfolioId: portfolio.id, limit: 5 });
        if (!failed(page, 'listTransactions')) {
          lines.push(`First ${(page.transactions as Structured[]).length} recorded trade(s) in "${portfolio.name}" (oldest first):`);
          for (const t of page.transactions as Structured[]) lines.push(`- ${t.occurredAt} ${t.side} ${t.quantity} ${t.symbol} at ${usd(t.price)}, fees ${usd(t.fees)}, amount ${usd(t.amount)}`);
          if (page.meta.page.nextOffset !== null) lines.push(`More trades are available from offset ${page.meta.page.nextOffset}.`);
        }
      }
    } else if (/\b(holdings?|positions?|own|shares)\b/.test(q)) {
      const portfolio = await firstActivePortfolio();
      if (portfolio) {
        const page = await this.call(trace, 'listHoldings', { portfolioId: portfolio.id });
        if (!failed(page, 'listHoldings')) {
          lines.push(`Open holdings in "${portfolio.name}" as of ${page.portfolio.asOf}:`);
          for (const h of page.holdings as Structured[]) lines.push(`- ${h.symbol} (${h.exchangeMic}): quantity ${h.remainingQuantity}, cost basis ${usd(h.remainingCostBasis)}, market value ${usd(h.marketValue)}, quote ${h.quote ? `${usd(h.quote.price)} at ${h.quote.asOf}` : 'none'} (${h.quoteStatus})`);
          if (!(page.holdings as Structured[]).length) lines.push('- No open positions.');
          notes(page);
        }
      }
    } else {
      const overview = await this.call(trace, 'getPortfolioSummary', portfolioId ? { portfolioId } : {});
      if (!failed(overview, 'getPortfolioSummary')) {
        lines.push(`Your portfolios as of ${overview.meta.generatedAt}:`);
        for (const p of (overview.portfolios ?? [overview.portfolio]) as Structured[]) lines.push(`- ${p.name}${p.archived ? ' (archived)' : ''}: market value ${usd(p.totals.marketValue, 'unavailable (valuation incomplete)')}, remaining cost basis ${usd(p.totals.remainingCostBasis)}, realized gain/loss ${usd(p.totals.realizedGainLoss)}, unrealized gain/loss ${usd(p.totals.unrealizedGainLoss)}.`);
        if (overview.combined) lines.push(`Combined active portfolios: market value ${usd(overview.combined.marketValue, 'unavailable (valuation incomplete)')}, realized gain/loss ${usd(overview.combined.realizedGainLoss)}.`);
        notes(overview);
      }
    }
    const answer = `[Mock answer] ${lines.join('\n')}`;
    return { mode: 'mock', answer: answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS - 1)}…` : answer, toolCalls: trace };
  }
}
