/**
 * `findUnexplainedReopen` — a reopen straight out of `released`/`closed` with
 * nobody saying why. Reported independently on ceo-dashboard (ISS reopened
 * after base merge 5a7bbac with no Code Review needs_fix, no QA FAIL, no
 * comment after "Released") and finance-automation twice (ISS-32 and ISS-7,
 * both code→review 0 findings→QA PASS→released→manually reopened, zero
 * explanation). In every case forge-fix could only bounce to needs_info by
 * hand after burning a run.
 *
 * The existing empty-reopen guard does NOT cover these — it keys on "no prior
 * code/fix job", and these issues all shipped one.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

// cm:why queued by call order — the mock cannot see which table drizzle targeted, so the three selects are: entry into reopen, entry into the origin status, comments since
const queue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
          orderBy: () => ({ limit: async () => queue.shift() ?? [] }),
        }),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { findUnexplainedReopen } = await import('./empty-reopen-guard.js');

const REOPENED_AT = new Date('2026-08-01T12:00:00Z');
const SHIPPED_AT = new Date('2026-08-01T10:00:00Z');

const enteredReopenFrom = (from: string) => [
  { payload: { from, to: 'reopen' }, createdAt: REOPENED_AT },
];
const originEntry = [{ createdAt: SHIPPED_AT }];

function setup(...batches: unknown[][]) {
  queue.length = 0;
  queue.push(...batches);
}

describe('findUnexplainedReopen', () => {
  it('flags a reopen out of released with no comment since it shipped', async () => {
    setup(enteredReopenFrom('released'), originEntry, []);
    expect(await findUnexplainedReopen('iss-1')).toEqual({
      from: 'released',
      since: SHIPPED_AT,
    });
  });

  it('flags a reopen out of closed the same way', async () => {
    setup(enteredReopenFrom('closed'), originEntry, []);
    expect(await findUnexplainedReopen('iss-1')).toMatchObject({ from: 'closed' });
  });

  // cm:guard the whole point of the window opening at the SHIP, not at the reopen — a human who explains before flipping the status must not be treated as silent
  it('allows the dispatch when someone commented after it shipped', async () => {
    setup(enteredReopenFrom('released'), originEntry, [{ id: 'c1' }]);
    expect(await findUnexplainedReopen('iss-1')).toBeNull();
  });

  // cm:guard a review/QA reject reaches `reopen` from testing/tested/developed and its verdict comment IS what forge-fix scopes against — never block that path
  it.each(['testing', 'tested', 'developed', 'in_progress'])(
    'ignores a reopen arriving from %s',
    async (from) => {
      setup(enteredReopenFrom(from), originEntry, []);
      expect(await findUnexplainedReopen('iss-1')).toBeNull();
    },
  );

  it('allows the dispatch when the issue never entered reopen', async () => {
    setup([], [], []);
    expect(await findUnexplainedReopen('iss-1')).toBeNull();
  });

  it('allows the dispatch when the transition payload has no `from`', async () => {
    setup([{ payload: { to: 'reopen' }, createdAt: REOPENED_AT }], [], []);
    expect(await findUnexplainedReopen('iss-1')).toBeNull();
  });

  // cm:guard no recoverable window → fail open rather than invent one; guessing here would strand a legitimately reopened issue at needs_info
  it('allows the dispatch when the origin entry is missing from history', async () => {
    setup(enteredReopenFrom('released'), [], []);
    expect(await findUnexplainedReopen('iss-1')).toBeNull();
  });

  // cm:guard fail OPEN — a throwing guard must let the pipeline run rather than freeze every fix dispatch
  it('allows the dispatch when the check itself throws', async () => {
    const { db } = await import('../db/client.js');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    const original = (db as any).select;
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = () => {
      throw new Error('db down');
    };
    expect(await findUnexplainedReopen('iss-1')).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = original;
  });
});
