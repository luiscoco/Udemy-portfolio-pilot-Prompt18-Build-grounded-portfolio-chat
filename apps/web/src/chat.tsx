import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { conversationPageSchema, conversationResultSchema, messagePageSchema, chatTurnResultSchema, type ChatMessage } from '@portfolio-pilot/contracts';
import { apiRequest } from './lib/api-client';
import { ChatMarkdown } from './chat-markdown';
import { usePortfolios } from './portfolio';

export function Assistant() {
  const cache = useQueryClient();
  const portfolios = usePortfolios();
  const [selected, setSelected] = useState('');
  const [scope, setScope] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useInfiniteQuery({ queryKey: ['conversations'], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiRequest(`/api/conversations${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`, conversationPageSchema, { signal }),
    getNextPageParam: page => page.nextBefore ?? undefined });
  const conversations = list.data?.pages.flatMap(p => p.conversations) ?? [];
  const id = selected || conversations[0]?.id || '';
  async function create() {
    setCreating(true); setError('');
    try {
      const result = await apiRequest('/api/conversations', conversationResultSchema, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portfolioId: scope || null }) });
      // Select only after the list contains the new option, so the controlled select never points at a missing value.
      await cache.invalidateQueries({ queryKey: ['conversations'] }); setSelected(result.conversation.id);
    } catch (e) { setError((e as Error).message); } finally { setCreating(false); }
  }
  return <><div className="page-title"><span className="eyebrow">RESEARCH</span><h1>Assistant</h1><p>Research your authorized holdings and stored news with cited evidence. Quotes and news may be stale or synthetic.</p></div>
    <section className="card assistant-page"><label htmlFor="chat-scope">Scope for new conversation</label><select id="chat-scope" value={scope} onChange={e => setScope(e.target.value)}><option value="">All active portfolios</option>{portfolios.data?.portfolios.filter(p => !p.archivedAt).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <button type="button" disabled={creating} onClick={() => void create()}>New conversation</button>
      <label htmlFor="chat-conversation">Conversation</label><select id="chat-conversation" value={id} onChange={e => setSelected(e.target.value)}><option value="" disabled>Choose a conversation</option>{conversations.map(c => <option value={c.id} key={c.id}>{c.title} · {new Date(c.createdAt).toISOString()}</option>)}</select>
      {list.hasNextPage && <button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>More conversations</button>}
      {(error || list.error) && <p role="alert">{error || list.error?.message}</p>}
      {list.isPending && <p role="status">Loading conversations…</p>}
      {creating ? <p role="status">Creating conversation…</p> : id ? <ConversationView key={id} id={id} /> : <p>Create a conversation to begin.</p>}
    </section></>;
}
function ConversationView({ id }: { id: string }) {
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const history = useInfiniteQuery({ queryKey: ['chat-messages', id], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiRequest(`/api/conversations/${encodeURIComponent(id)}/messages${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`, messagePageSchema, { signal }),
    getNextPageParam: page => page.nextBefore ?? undefined, refetchInterval: 5000 });
  const unique = new Map<string, ChatMessage>();
  for (const page of [...(history.data?.pages ?? [])].reverse()) for (const message of page.messages) unique.set(message.id, message);
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (pending || !content.trim()) return;
    setPending(true); setError('');
    try {
      await apiRequest(`/api/conversations/${encodeURIComponent(id)}/messages`, chatTurnResultSchema, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }), timeoutMs: 80000 });
      setContent('');
    } catch (e) { setError(`${(e as Error).message} Refresh messages before retrying; an accepted request may still finish.`); }
    finally { setPending(false); await history.refetch(); }
  }
  return <div className="chat-panel">
    {history.hasNextPage && <button type="button" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load earlier messages</button>}
    <button type="button" onClick={() => void history.refetch()}>Refresh messages</button>
    {history.isPending && <p role="status">Loading messages…</p>}
    {history.error && <p role="alert">{history.error.message}</p>}
    <div aria-label="Conversation messages">{[...unique.values()].map(m => <article key={m.id} className="chat-answer"><strong>{m.role === 'user' ? 'You' : m.mode === 'mock' ? 'Assistant · MOCK' : 'Assistant'}{m.status === 'failed' ? ' · Failed' : ''}</strong><time dateTime={m.createdAt}> · {m.createdAt} UTC</time><ChatMarkdown content={m.content} sources={m.sources} />{m.sources.length > 0 && <ul aria-label="Validated article sources">{m.sources.map(s => <li key={s.articleId}><ChatMarkdown content={`[${s.articleId}](${s.url})`} sources={[s]} />{s.title} · Published {s.publishedAt}{s.isSynthetic ? ' · MOCK / synthetic' : ''}</li>)}</ul>}</article>)}</div>
    <form onSubmit={send}><label htmlFor="chat-question">Ask about your portfolio</label><div className="chat-input"><textarea id="chat-question" value={content} onChange={e => setContent(e.target.value)} maxLength={2000} required placeholder="Which recent news affects my largest holding?" /><button disabled={pending || !content.trim()} type="submit">Send</button></div></form>
    {pending && <p role="status">Researching…</p>}{error && <p role="alert">{error}</p>}
    <p>Largest means current USD market value. Recent means the last seven days. Saved history uses a bounded context window. This assistant cannot execute trades.</p>
  </div>;
}
