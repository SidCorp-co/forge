/**
 * ISS-1023 criterion 37 — the prior-attempts walk reports each attempt's message count without
 * reading that session's transcript.
 *
 * Its own file because `prior-attempts.test.ts` mocks `../db/client.js` as the empty object `{}`
 * and imports only the renderer; nothing there can reach `loadPriorAttempts`, and the walk had no
 * test of any kind. Found while re-judging the criteria on 2026-09-18: reverting the ledger read
 * to `select({ messages })` plus `.length` would have kept the whole suite green, and the defect
 * it restores is a 35 MB transcript crossing the wire on the dispatch path to print one number
 * into a prompt.
 *
 * The claim is about what the SELECT asks for, so the stub records the projections rather than
 * only the answers: an assertion on the returned `messageCount` passes whichever column the count
 * came from.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { jobs } from '../db/schema.js';

/** Each `db.select(...)` projection the walk built, in call order. */
const projections = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/** What the next `.limit()` / awaited builder resolves. */
const results = vi.hoisted(() => [] as unknown[][]);

vi.mock('../db/client.js', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'innerJoin', 'leftJoin']) c[m] = () => c;
    c.limit = () => Promise.resolve(results.shift() ?? []);
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(results.shift() ?? []).then(resolve, reject);
    return c;
  };
  return {
    db: {
      select: (projection: Record<string, unknown>) => {
        projections.push(projection);
        return chain();
      },
    },
  };
});

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadPriorAttempts } = await import('./prior-attempts.js');

function job(over: Partial<typeof jobs.$inferSelect> = {}): typeof jobs.$inferSelect {
  return { id: 'job-current', retryOf: 'job-prev', ...over } as typeof jobs.$inferSelect;
}

describe('loadPriorAttempts counts off the turn ledger (ISS-1023)', () => {
  beforeEach(() => {
    projections.length = 0;
    results.length = 0;
  });

  it('never asks for the `messages` column, and takes the count from a second query', async () => {
    results.push([
      {
        id: 'job-prev',
        attempts: 2,
        retryOf: null,
        agentSessionId: 'sess-prev',
        failureReason: 'spend limit',
        failureMeta: null,
      },
    ]);
    results.push([{ turns: 7 }]);

    const out = await loadPriorAttempts(job());

    const keys = projections.flatMap((p) => Object.keys(p));
    expect({
      asksForMessages: keys.includes('messages'),
      queries: projections.length,
      countProjection: Object.keys(projections[1] ?? {}),
      messageCount: out[0]?.messageCount,
    }).toEqual({
      // `messages` must appear in NEITHER projection — the jobs row or the count query. The count
      // is its own query against the ledger, which is why there are two.
      asksForMessages: false,
      queries: 2,
      countProjection: ['turns'],
      messageCount: 7,
    });
  });

  it('reports an unknown count rather than zero when the ledger holds nothing', async () => {
    results.push([
      {
        id: 'job-prev',
        attempts: 1,
        retryOf: null,
        agentSessionId: 'sess-prev',
        failureReason: null,
        failureMeta: null,
      },
    ]);
    // `max(turn_index) + 1` over no rows is SQL NULL, which is the shape the ledger returns for
    // the 2,339 beta sessions that hold a real transcript and no turn row.
    results.push([{ turns: null }]);

    const out = await loadPriorAttempts(job());

    expect({ messageCount: out[0]?.messageCount, isZero: out[0]?.messageCount === 0 }).toEqual({
      messageCount: null,
      isZero: false,
    });
  });

  it('asks the ledger nothing for an attempt that recorded no session', async () => {
    // The boundary: no session id means no second query at all, and still not a zero.
    results.push([
      {
        id: 'job-prev',
        attempts: 1,
        retryOf: null,
        agentSessionId: null,
        failureReason: null,
        failureMeta: null,
      },
    ]);

    const out = await loadPriorAttempts(job());

    expect({ queries: projections.length, messageCount: out[0]?.messageCount }).toEqual({
      queries: 1,
      messageCount: null,
    });
  });
});
