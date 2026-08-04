import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

// cm:why queued by call order — the mock cannot see which table drizzle targeted, so the three selects are: last departure from the stage, comments since, non-status activity since
const queue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = queue.shift() ?? [];
          const chain = {
            limit: async () => rows,
            orderBy: () => ({ limit: async () => rows }),
          };
          return chain;
        },
      }),
    }),
  },
}));

const { findUnansweredBounce, BOUNCE_STATUSES } = await import('./bounce-replay-guard.js');

const BOUNCED_AT = new Date('2026-08-01T10:00:00Z');
const departure = (to: string) => [{ payload: { from: 'approved', to }, createdAt: BOUNCED_AT }];

function setup(...batches: unknown[][]) {
  queue.length = 0;
  queue.push(...batches);
}

describe('findUnansweredBounce', () => {
  it('blocks a replay when the stage was exited to waiting and nothing followed', async () => {
    setup(departure('waiting'), [], []);
    const out = await findUnansweredBounce('iss-1', 'approved');
    expect(out).toEqual({ bounced: 'waiting', at: BOUNCED_AT });
  });

  it.each(BOUNCE_STATUSES)('treats %s as a bounce', async (status) => {
    setup(departure(status), [], []);
    const out = await findUnansweredBounce('iss-1', 'approved');
    expect(out?.bounced).toBe(status);
  });

  it('allows the dispatch when the stage was exited forward, not bounced', async () => {
    setup(departure('developed'), [], []);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  it('allows the dispatch when the stage was never exited', async () => {
    setup([], [], []);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  // cm:guard a human answering the bounce MUST release the guard — blocking after real input would strand the issue, which is far worse than the wasted run this guard exists to prevent
  it('allows the dispatch when a comment landed after the bounce', async () => {
    setup(departure('waiting'), [{ id: 'c1' }], []);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  it('allows the dispatch when non-status activity landed after the bounce', async () => {
    setup(departure('waiting'), [], [{ id: 'a1' }]);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  it('ignores a departure whose `to` is missing', async () => {
    setup([{ payload: { from: 'approved' }, createdAt: BOUNCED_AT }], [], []);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  // cm:guard fail OPEN — a throwing guard must let the pipeline run rather than freeze every dispatch behind a broken query
  it('allows the dispatch when the check itself throws', async () => {
    const { db } = await import('../db/client.js');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    const original = (db as any).select;
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = () => {
      throw new Error('db down');
    };
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = original;
  });
});
