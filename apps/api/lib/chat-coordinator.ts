import { PortfolioError } from '@portfolio-pilot/db';

/** Replace with a durable worker implementation at milestone 27. No request signal is accepted. */
export interface RunCoordinator {
  execute<T>(ownerKey: string, conversationId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
export class LocalRunCoordinator implements RunCoordinator {
  private readonly conversations = new Set<string>();
  private readonly owners = new Map<string, number>();
  constructor(private readonly maxActive = 4, private readonly maxPerOwner = 2, private readonly timeoutMs = 90000) {}
  async execute<T>(ownerKey: string, conversationId: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.conversations.has(conversationId)) throw new PortfolioError(409, 'This conversation is already answering. Refresh its messages before retrying.');
    const count = this.owners.get(ownerKey) ?? 0;
    if (this.conversations.size >= this.maxActive || count >= this.maxPerOwner) throw new PortfolioError(409, 'The assistant is busy. Try again after an active answer finishes.');
    // Reserve synchronously before the first await; no unbounded queue or cross-user shared context.
    this.conversations.add(conversationId); this.owners.set(ownerKey, count + 1);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = Promise.resolve().then(() => run(controller.signal)).finally(() => {
      if (timer) clearTimeout(timer);
      this.conversations.delete(conversationId);
      const remaining = (this.owners.get(ownerKey) ?? 1) - 1;
      if (remaining) this.owners.set(ownerKey, remaining); else this.owners.delete(ownerKey);
    });
    // Keep admission reserved until work actually settles, even if a dependency ignores abort.
    // Releasing on timeout would allow unbounded background work and concurrent turns.
    return Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PortfolioError(503, 'The assistant exceeded its local time limit. Refresh messages before retrying.')); }, this.timeoutMs);
    })]);
  }
}
const local = globalThis as typeof globalThis & { portfolioChatCoordinator?: RunCoordinator };
export const chatCoordinator = local.portfolioChatCoordinator ??= new LocalRunCoordinator();
