import { createContext, useContext, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { StreamManager, type NewsNotice } from './lib/stream-manager';

const ConnectionContext = createContext<'Live' | 'Reconnecting' | 'Offline'>('Offline');
const NewsNoticeContext = createContext<NewsNotice[]>([]);
export const useNewsNotices = () => useContext(NewsNoticeContext);
export function StreamingProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const cache = useQueryClient();
  const [manager] = useState(() => new StreamManager(userId, cache));
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  return <ConnectionContext value={state.connection}><NewsNoticeContext value={state.newsNotices}><ConnectionStatus />{state.ready ? children : <p role="status">Loading authorized snapshot…</p>}</NewsNoticeContext></ConnectionContext>;
}
export function ConnectionStatus() {
  const state = useContext(ConnectionContext);
  return <span role="status" aria-label="Update connection" className="stream-status">{state} · App updates. Provider polling and delays still apply.</span>;
}
