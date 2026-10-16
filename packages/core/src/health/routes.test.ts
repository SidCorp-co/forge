// The public health answer counts the pg-boss errors this process has logged since boot, so a
// recurring one shows on a poll of /health and not only in a log tail; never its message.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./service.js', () => ({
  readLiveness: async () => ({ ok: true, dbOk: true, queueOk: true, wsOk: true }),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { publicHealthRoutes } = await import('./routes.js');
const { onBossError } = await import('../queue/boss-errors.js');

const health = async () =>
  (await (await publicHealthRoutes.request('/health')).json()) as {
    queue: Record<string, unknown>;
  };

describe('/health', () => {
  it('counts pg-boss errors since boot and carries none of their text', async () => {
    const before = (await health()).queue.errorsSinceBoot as number;
    onBossError({ message: 'secret-looking detail', queue: 'outbox.q', worker: 'w' });
    const after = await health();
    expect(after.queue).toEqual({ ok: true, errorsSinceBoot: before + 1 });
    expect(JSON.stringify(after)).not.toContain('secret-looking');
  });
});
