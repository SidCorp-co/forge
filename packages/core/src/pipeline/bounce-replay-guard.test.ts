import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

// cm:why queued by call order — the mock cannot see which table drizzle targeted, so the three selects are: last departure from the stage, comments since, non-status activity since
const queue: unknown[][] = [];
const wheres: unknown[][] = [];
let selectCalls = 0;
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...conds: unknown[]) => {
          selectCalls += 1;
          wheres.push(conds);
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

let healthyDevices: string[] = [];
const onlineCapableDeviceIds = vi.fn(async () => healthyDevices);
vi.mock('../runners/select.js', () => ({
  onlineCapableDeviceIds: (...args: unknown[]) =>
    (onlineCapableDeviceIds as unknown as (...a: unknown[]) => Promise<string[]>)(...args),
}));

const { findUnansweredBounce, BOUNCE_STATUSES, reopenEnteredFromNeedsInfo } = await import(
  './bounce-replay-guard.js'
);

const parkedRun = (parkReason: string) => [{ projectId: 'proj-1', parkReason }];

const BOUNCED_AT = new Date('2026-08-01T10:00:00Z');
const departure = (to: string) => [{ payload: { from: 'approved', to }, createdAt: BOUNCED_AT }];

function setup(...batches: unknown[][]) {
  queue.length = 0;
  wheres.length = 0;
  selectCalls = 0;
  healthyDevices = [];
  onlineCapableDeviceIds.mockClear();
  queue.push(...batches);
}

/** Does a captured drizzle condition tree reference this column? */
function filtersOn(conds: unknown, column: string): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 8 || node === null || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if (rec.name === column) return true;
    return Object.values(rec).some((v) => walk(v, depth + 1));
  };
  return walk(conds, 0);
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

  // cm:guard the park release query must stay filtered to isAi=false — postSkippedParkExitComment fires from the post-commit transition hook, AFTER the departure this window is anchored on, so an unfiltered query lets the park-exit explanation release the very bounce it describes and the reconciler then dispatches a full-tier job
  it('excludes system (isAi) comments from the waiting/on_hold release query', async () => {
    setup(departure('waiting'), [], []);
    await findUnansweredBounce('iss-1', 'approved');
    expect(filtersOn(wheres[1], 'is_ai')).toBe(true);
  });

  it('still releases a park on non-status activity, so a real environment change is not swallowed', async () => {
    setup(departure('waiting'), [], [{ id: 'a1' }]);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  it('allows the dispatch when non-status activity landed after the bounce', async () => {
    setup(departure('waiting'), [], [{ id: 'a1' }]);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  it('allows the dispatch when non-status activity landed after an on_hold bounce', async () => {
    setup(departure('on_hold'), [], [{ id: 'a1' }]);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  // cm:guard ISS-820 — an agent's own comment (or unrelated activity) must NOT release its own needs_info bounce, or a fabricated "the owner decided" comment can silently override a real human answer. needs_info has no activity-log fallback and issues a single human-filtered comment query, so an empty result here models "no human comment" regardless of what non-human input landed.
  it('still blocks a needs_info replay when no human-authored comment has landed since', async () => {
    setup(departure('needs_info'), []);
    expect(await findUnansweredBounce('iss-1', 'approved')).toEqual({
      bounced: 'needs_info',
      at: BOUNCED_AT,
    });
  });

  it('releases a needs_info bounce only on a human-authored comment (isAi=false, no device)', async () => {
    setup(departure('needs_info'), [{ id: 'c1' }]);
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  // cm:guard the code/fix shape — forge_step_start flips the issue to `in_progress`, so the departure FROM `approved` is the in-flight hop and the bounce is recorded one hop later. Before ISS-85 the guard stopped at the first hop and returned null, so it never fired for the two most expensive stages — sid-desk ISS-85 re-dispatched 7 times past it.
  it('follows the in-flight hop for code/fix and still blocks the replay', async () => {
    const bouncedAt = new Date('2026-08-01T10:05:00Z');
    setup(
      departure('in_progress'),
      [{ payload: { from: 'in_progress', to: 'waiting' }, createdAt: bouncedAt }],
      [],
      [],
    );
    const out = await findUnansweredBounce('iss-1', 'approved');
    expect(out).toEqual({ bounced: 'waiting', at: bouncedAt });
  });

  it('allows the dispatch when the in-flight hop exited forward', async () => {
    setup(
      departure('in_progress'),
      [{ payload: { from: 'in_progress', to: 'developed' }, createdAt: BOUNCED_AT }],
      [],
      [],
    );
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  // cm:guard input landing after the BOUNCE (not after the in-flight hop) must still release it
  it('allows the dispatch when a comment landed after the in-flight bounce', async () => {
    setup(
      departure('in_progress'),
      [{ payload: { from: 'in_progress', to: 'waiting' }, createdAt: BOUNCED_AT }],
      [{ id: 'c1' }],
      [],
    );
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  it('allows the dispatch when the in-flight hop has no recorded exit yet', async () => {
    setup(departure('in_progress'), [], [], []);
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

describe('findUnansweredBounce — capacity parks', () => {
  // cm:guard the whole point of ISS-163: a step cut off by provider quota reached NO conclusion, so once the fleet is healthy there is nothing to replay and demanding a human answer wedges the issue forever
  it('releases a capacity park once the fleet has recovered', async () => {
    setup(departure('waiting'), [], [], parkedRun('all_devices_exhausted'));
    healthyDevices = ['dev-1'];
    expect(await findUnansweredBounce('iss-1', 'approved')).toBeNull();
  });

  it('keeps the bounce while every runner is still limited', async () => {
    setup(departure('waiting'), [], [], parkedRun('all_devices_exhausted'));
    healthyDevices = [];
    expect(await findUnansweredBounce('iss-1', 'approved')).toEqual({
      bounced: 'waiting',
      at: BOUNCED_AT,
    });
  });

  // cm:guard a rounds-exhausted park DID reach a conclusion (the step kept failing on its own merits) — re-running it unchanged repeats the failure, so a healthy fleet must not release it
  it('keeps the bounce for a non-capacity park reason even with a healthy fleet', async () => {
    setup(departure('waiting'), [], [], parkedRun('retry_rounds_exhausted'));
    healthyDevices = ['dev-1'];
    expect((await findUnansweredBounce('iss-1', 'approved'))?.bounced).toBe('waiting');
  });

  it('keeps the bounce when the park reason was never recorded', async () => {
    setup(departure('waiting'), [], [], []);
    healthyDevices = ['dev-1'];
    expect((await findUnansweredBounce('iss-1', 'approved'))?.bounced).toBe('waiting');
  });

  // cm:guard ISS-820 must survive this feature: a parkReason left on the latest run by an EARLIER capacity park must never release a LATER needs_info bounce, so the fleet is not even consulted for it
  it('never consults the fleet for a needs_info bounce', async () => {
    setup(departure('needs_info'), [], parkedRun('all_devices_exhausted'));
    healthyDevices = ['dev-1'];
    expect((await findUnansweredBounce('iss-1', 'approved'))?.bounced).toBe('needs_info');
    expect(onlineCapableDeviceIds).not.toHaveBeenCalled();
  });
});

describe('reopenEnteredFromNeedsInfo', () => {
  const enteredReopenFrom = (from: string) => [{ payload: { from, to: 'reopen' } }];

  it('flags a reopen that arrived directly from needs_info with no input since', async () => {
    setup(enteredReopenFrom('needs_info'), [], []);
    expect(await reopenEnteredFromNeedsInfo('iss-1')).toBe(true);
  });

  it('releases the guard when a human comment followed the needs_info entry', async () => {
    setup(enteredReopenFrom('needs_info'), [{ createdAt: BOUNCED_AT }], [{ id: 'c1' }]);
    expect(await reopenEnteredFromNeedsInfo('iss-1')).toBe(false);
  });

  // cm:guard ISS-820 — the release query is already filtered to human comments (isAi=false, no device), so an empty third batch models "only agent comments or bare activity landed". A fix must never be scoped from a question no human answered — this guard's OWN comment is agent-authored and lands right before the needs_info entry it routes to.
  it('keeps blocking when only agent-authored input followed the needs_info entry', async () => {
    setup(enteredReopenFrom('needs_info'), [{ createdAt: BOUNCED_AT }], []);
    expect(await reopenEnteredFromNeedsInfo('iss-1')).toBe(true);
  });

  // cm:guard the activity-log fallback must stay OUT of the needs_info path — three selects (reopen entry, needs_info entry, human comment) and no fourth, or bare activity silently answers the question again
  it('issues no activity-log fallback query for the needs_info release check', async () => {
    setup(enteredReopenFrom('needs_info'), [{ createdAt: BOUNCED_AT }], []);
    await reopenEnteredFromNeedsInfo('iss-1');
    expect(selectCalls).toBe(3);
  });

  it.each(['testing', 'tested', 'developed', 'released', 'closed'])(
    'ignores a reopen arriving from %s',
    async (from) => {
      setup(enteredReopenFrom(from));
      expect(await reopenEnteredFromNeedsInfo('iss-1')).toBe(false);
    },
  );

  it('allows the dispatch when the issue never entered reopen', async () => {
    setup([]);
    expect(await reopenEnteredFromNeedsInfo('iss-1')).toBe(false);
  });

  it('allows the dispatch when the transition payload has no `from`', async () => {
    setup([{ payload: { to: 'reopen' } }]);
    expect(await reopenEnteredFromNeedsInfo('iss-1')).toBe(false);
  });

  // cm:guard fail OPEN — a broken guard must let the pipeline run, never silently freeze every dispatch
  it('allows the dispatch when the check itself throws', async () => {
    const { db } = await import('../db/client.js');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    const original = (db as any).select;
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = () => {
      throw new Error('db down');
    };
    expect(await reopenEnteredFromNeedsInfo('iss-1')).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = original;
  });
});
