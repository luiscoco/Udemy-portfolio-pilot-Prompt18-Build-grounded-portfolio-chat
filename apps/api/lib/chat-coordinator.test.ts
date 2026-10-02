import { expect, it, vi } from 'vitest';
import { LocalRunCoordinator } from './chat-coordinator';
it('enforces conversation, owner and global admission limits, releasing after failure', async () => {
  const coordinator = new LocalRunCoordinator(2, 1);
  let finish!: () => void;
  const first = coordinator.execute('alice', 'a', () => new Promise<void>(resolve => { finish = resolve; }));
  await expect(coordinator.execute('bob', 'a', async () => 1)).rejects.toMatchObject({ status: 409 });
  await expect(coordinator.execute('alice', 'b', async () => 1)).rejects.toMatchObject({ status: 409 });
  let endSecond!: () => void;
  const second = coordinator.execute('bob', 'b', () => new Promise<void>(resolve => { endSecond = resolve; }));
  await expect(coordinator.execute('carol', 'c', async () => 1)).rejects.toMatchObject({ status: 409 });
  finish(); endSecond(); await Promise.all([first, second]);
  await expect(coordinator.execute('alice', 'a', async () => { throw new Error('test'); })).rejects.toThrow('test');
  expect(await coordinator.execute('alice', 'a', async () => 'done')).toBe('done');
});
it('aborts at the wall-clock limit without releasing a still-running turn', async () => {
  vi.useFakeTimers();
  try {
    const coordinator = new LocalRunCoordinator(1, 1, 100);
    let finish!: () => void; let aborted = false;
    const run = coordinator.execute('alice', 'a', signal => new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => { aborted = true; }); }));
    const rejected = expect(run).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(aborted).toBe(true);
    await expect(coordinator.execute('alice', 'a', async () => 1)).rejects.toMatchObject({ status: 409 });
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(await coordinator.execute('alice', 'a', async () => 1)).toBe(1);
  } finally { vi.useRealTimers(); }
});
