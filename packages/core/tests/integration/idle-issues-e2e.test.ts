import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_AGO, registerIdleFixture, testLease } from '../helpers/idle-fixture.js';

/** Every notification this pass emitted, so what it SAYS is assertable and not just that it said. */
const emitted: Array<{ title: string; body: string }> = [];
vi.mock('../../src/notifications/emit.js', () => ({
  emitNotification: async (args: { title: string; body: string }) => {
    emitted.push({ title: args.title, body: args.body });
    return { delivered: 1 };
  },
}));

/**
 * The admin lookup is a real seam inside the pass, between the page read and the row writes. A
 * hook on it is how a concurrent writer is put INSIDE that window deterministically — the `db`
 * export is a Proxy whose `get` trap always answers with the live instance's own method, so
 * spying it intercepts nothing.
 */
let betweenReadAndWrite: (() => Promise<void>) | null = null;
vi.mock('../../src/notifications/project-admins.js', () => ({
  projectAdminUserIdsFor: async (ids: readonly string[]) => {
    if (betweenReadAndWrite) await betweenReadAndWrite();
    return new Map(ids.map((id) => [id, [`admin-of-${id}`]]));
  },
  projectAdminUserIds: async () => ['admin'],
}));

/**
 * ISS-1122 — the issue-level invariant, proved against real SQL.
 *
 * Every instance recorded on the issue is a row this pass either reaches or does not, and which
 * rows it reaches IS the behaviour: a mocked `db.execute` returns whatever a test hands it, so the
 * unit suites prove the classifiers and are no evidence at all about the predicate. The three
 * instances are seeded here as they were measured on 2026-09-20, and so are the inverses — a
 * detector that flags everything is the same defect as one that flags nothing.
 */

const fx = registerIdleFixture(1100);
const NOW = new Date('2026-09-20T16:00:00.000Z');

let mods: {
  reconcileIdleIssues: (
    now?: Date,
    scope?: { projectId?: string },
  ) => Promise<{
    detected: number;
    reported: number;
    leasesReleased: number;
    cleared: number;
    unclassified: number;
  }>;
};

beforeAll(async () => {
  mods = (await import('../../src/pipeline/idle-issues.js')) as unknown as typeof mods;
}, 60_000);

beforeEach(async () => {
  emitted.length = 0;
  betweenReadAndWrite = null;
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

const seedIssue = (args: Parameters<typeof fx.seedIssue>[0]) => fx.seedIssue(args);
const addRun = (issueId: string, status: 'running' | 'completed') => fx.seedRun(issueId, status);
const addLiveJob = (issueId: string) => fx.seedLiveJob(issueId);
const addRunner = (status: 'online' | 'draining' | 'disabled') => fx.seedRunner(status);
const lease = testLease;
const LONG_AGO_TS = LONG_AGO;

async function strandOf(issueId: string): Promise<Record<string, unknown> | null> {
  const rows = (await fx.db.execute(sql`
    SELECT session_context -> 'strand' AS strand FROM issues WHERE id = ${issueId}
  `)) as unknown as Array<{ strand: Record<string, unknown> | null }>;
  return rows[0]?.strand ?? null;
}

async function leaseOf(issueId: string): Promise<Record<string, unknown> | null> {
  const rows = (await fx.db.execute(sql`
    SELECT session_context -> 'lease' AS lease FROM issues WHERE id = ${issueId}
  `)) as unknown as Array<{ lease: Record<string, unknown> | null }>;
  return rows[0]?.lease ?? null;
}

describe('The three instances recorded on ISS-1122, 2026-09-20', () => {
  /**
   * Instance 1 — ISS-1126 was filed `open` at 15:04. Core published `master.wake` exactly as
   * designed and a listener received it; nothing could act, because `dev1` was draining and
   * `sid-xeon-1` was disabled. Published and acted on are different facts.
   */
  it('reaches an `open` row whose project has no runner the pool would admit, and names it', async () => {
    await addRunner('draining');
    await addRunner('disabled');
    const issueId = await seedIssue({ status: 'open' });

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.detected).toBe(1);
    const strand = await strandOf(issueId);
    expect(strand?.status).toBe('open');
    expect(String(strand?.reason)).toContain('job pool');
    expect(strand?.owes).toBe('human');
    expect((strand?.evidence as Record<string, unknown>)?.poolHasRunner).toBe(false);
  });

  it('names the missing dispatch instead where a runner IS admitted', async () => {
    await addRunner('online');
    await addRunner('draining');
    const issueId = await seedIssue({ status: 'open' });

    await mods.reconcileIdleIssues(NOW);

    const strand = await strandOf(issueId);
    expect(String(strand?.reason)).toContain('dispatch did not happen');
    expect((strand?.evidence as Record<string, unknown>)?.poolHasRunner).toBe(true);
  });

  /**
   * Instance 2 — ISS-1105 and ISS-1111 sat `in_progress` from 09:37 to 15:29 under a holder that
   * could not let go: `forge claim --stopped` wrote nothing, and every other write renewed the
   * lock. The sweep is the one party that can end it.
   */
  it('releases a lapsed lease and records what lapsed, without moving the status', async () => {
    const issueId = await seedIssue({
      status: 'in_progress',
      sessionContext: { lease: lease({ renewedAt: '2026-09-20T09:37:00.000Z' }) },
    });
    await addRun(issueId, 'completed');

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.detected).toBe(1);
    expect(result.leasesReleased).toBe(1);

    const held = await leaseOf(issueId);
    expect(held?.stopped).toBe(NOW.toISOString());
    expect(held?.holder).toBe(lease().holder);
    const history = held?.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[1]?.how).toBe('swept');

    const strand = await strandOf(issueId);
    expect(String(strand?.reason)).toContain('ran past its own expiry');

    const status = (await fx.db.execute(sql`
        SELECT status FROM issues WHERE id = ${issueId}
      `)) as unknown as Array<{ status: string }>;
    expect(status[0]?.status).toBe('in_progress');
  });

  /**
   * Instance 3 — ISS-1106, ISS-1107 and ISS-1108 were `in_progress` under a session id that
   * `forge claim` itself warns "names a wave and not a run". Their leases were unexpired at the
   * moment this shape was measured, so the fanout is the only thing that separates them from
   * healthy work. They are reported, and their leases are NOT taken away.
   */
  it('reports three rows sharing one unexpired holder and releases none of their leases', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await seedIssue({
          status: 'in_progress',
          sessionContext: { lease: lease({ holder: 'wave-66a33b93' }) },
        }),
      );
    }

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.detected).toBe(3);
    expect(result.leasesReleased).toBe(0);
    for (const id of ids) {
      const strand = await strandOf(id);
      expect(strand?.lease).toBe('shared');
      expect(String(strand?.reason)).toContain('3 issues at once');
      expect(String(strand?.reason)).toContain('not evidence');
      expect((await leaseOf(id))?.stopped).toBeUndefined();
    }
  });
});

describe('The inverses: a detector that flags everything is the same defect', () => {
  it.each([
    ['shared', { lease: { holder: 'w', minutes: 60, renewedAt: '2026-09-20T15:45:00.000Z' } }],
    ['malformed', { lease: { holder: 'm', minutes: 60, renewedAt: 'whenever' } }],
  ])(
    'says no live work could be CONFIRMED where the %s lease concludes nothing',
    async (verdict, ctx) => {
      await seedIssue({ status: 'in_progress', sessionContext: ctx });
      if (verdict === 'shared') await seedIssue({ status: 'in_progress', sessionContext: ctx });

      await mods.reconcileIdleIssues(NOW);

      expect(emitted.length).toBeGreaterThan(0);
      for (const note of emitted) {
        expect(note.title).toContain('no live work could be confirmed');
        expect(note.title).not.toContain('nothing is working it');
        expect(note.body).toContain('establishes nothing either way');
      }
    },
  );

  it('says nothing is working it only where the lease establishes that', async () => {
    await seedIssue({ status: 'developed' });

    await mods.reconcileIdleIssues(NOW);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.title).toContain('nothing is working it');
    expect(emitted[0]?.body).toContain('no live job, run or lease behind it');
  });

  it('leaves a row alone whose unexpired lease is held on it and nothing else', async () => {
    const issueId = await seedIssue({
      status: 'in_progress',
      sessionContext: { lease: lease({ holder: 'one-run-only' }) },
    });

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.detected).toBe(0);
    expect(await strandOf(issueId)).toBeNull();
    expect((await leaseOf(issueId))?.stopped).toBeUndefined();
  });

  it('leaves a row alone that has a live job on it', async () => {
    const issueId = await seedIssue({ status: 'in_progress' });
    await addLiveJob(issueId);

    expect((await mods.reconcileIdleIssues(NOW)).detected).toBe(0);
    expect(await strandOf(issueId)).toBeNull();
  });

  it('leaves a row alone that has a live run on it', async () => {
    const issueId = await seedIssue({ status: 'developed' });
    await addRun(issueId, 'running');

    expect((await mods.reconcileIdleIssues(NOW)).detected).toBe(0);
    expect(await strandOf(issueId)).toBeNull();
  });

  it('leaves a row alone that a live session holds a lease on', async () => {
    const issueId = await seedIssue({ status: 'testing' });
    await fx.seedIssueLease(fx.lastSeq, 'running');

    expect((await mods.reconcileIdleIssues(NOW)).detected).toBe(0);
    expect(await strandOf(issueId)).toBeNull();
  });

  it('reads a row as stranded once the session holding its lease is terminal', async () => {
    const issueId = await seedIssue({ status: 'testing' });
    await fx.seedIssueLease(fx.lastSeq, 'completed');

    expect((await mods.reconcileIdleIssues(NOW)).detected).toBe(1);
    expect(await strandOf(issueId)).not.toBeNull();
  });

  it('leaves a row alone that has not yet spent its own status grace', async () => {
    const issueId = await seedIssue({
      status: 'awaiting_release',
      updatedAt: '2026-09-19T20:00:00.000Z',
    });

    expect((await mods.reconcileIdleIssues(NOW)).detected).toBe(0);
    expect(await strandOf(issueId)).toBeNull();
  });

  it.each(['draft', 'waiting', 'on_hold', 'needs_info', 'closed', 'dropped'])(
    'leaves a `%s` row alone, which the rule table declares at rest',
    async (status) => {
      // A `closed` row carries a merge mark or it cannot exist (ISS-1108).
      const issueId = await seedIssue({
        status,
        ...(status === 'closed' ? { mergedAt: LONG_AGO_TS } : {}),
      });

      expect((await mods.reconcileIdleIssues(NOW)).detected).toBe(0);
      expect(await strandOf(issueId)).toBeNull();
    },
  );
});

describe('Coverage the three existing passes do not have', () => {
  it.each(['confirmed', 'approved', 'developed', 'tested', 'reopen', 'awaiting_release'])(
    'reaches a `%s` row with no merge mark, which no existing pass reads',
    async (status) => {
      const issueId = await seedIssue({ status });

      const result = await mods.reconcileIdleIssues(NOW);

      expect(result.detected).toBe(1);
      expect((await strandOf(issueId))?.status).toBe(status);
    },
  );

  it('does not require a merge mark, and says which of the two it saw', async () => {
    const unmerged = await seedIssue({ status: 'developed' });
    await addRun(unmerged, 'completed');
    const merged = await seedIssue({
      status: 'developed',
      mergedAt: '2026-09-14T00:00:00.000Z',
    });
    await addRun(merged, 'completed');

    expect((await mods.reconcileIdleIssues(NOW)).detected).toBe(2);
    expect(String((await strandOf(unmerged))?.reason)).toContain('no merge mark');
    expect(String((await strandOf(merged))?.reason)).toContain('merge mark and nothing has moved');
  });
});

describe('Refusing by name rather than dropping the row', () => {
  /**
   * `issues.status` is a text column under a CHECK constraint, and the constraint and
   * `issueStatuses` are two lists that a migration moves one at a time. The row below is what the
   * database holds between those two halves: a status the constraint already admits and this
   * build's rule table does not. The fixture widens the constraint to reach it, because that is
   * the only way the state arises — and it is the state both existing detectors would drop
   * silently, since each selects by an `IN` over statuses it knows.
   */
  it('counts a status the rule table does not hold rather than dropping it', async () => {
    const id = randomUUID();
    await fx.db.execute(sql`ALTER TABLE issues DROP CONSTRAINT issues_status_chk`);
    try {
      await fx.db.execute(sql`
          INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id, created_at, updated_at)
          VALUES (${id}, ${fx.projectId}, ${fx.lastSeq + 1}, 'a status from the future', 'quarantined', 'medium',
                  ${fx.ownerId}, ${LONG_AGO_TS}::timestamptz, ${LONG_AGO_TS}::timestamptz)
        `);

      const result = await mods.reconcileIdleIssues(NOW);

      expect(result.unclassified).toBe(1);
      expect(result.detected).toBe(1);
      const strand = await strandOf(id);
      expect(String(strand?.reason)).toContain('quarantined');
      expect(strand?.owes).toBe('human');
    } finally {
      await fx.db.execute(sql`UPDATE issues SET status = 'on_hold' WHERE status = 'quarantined'`);
      await fx.db.execute(sql`
          ALTER TABLE issues ADD CONSTRAINT issues_status_chk
          CHECK (status IN ('open','confirmed','clarified','waiting','approved','in_progress',
                            'developed','testing','tested','awaiting_release','releasing','closed',
                            'reopen','on_hold','needs_info','draft','dropped'))
        `);
    }
  });

  it('reports a lease it cannot read and leaves it standing', async () => {
    const issueId = await seedIssue({
      status: 'in_progress',
      sessionContext: { lease: { holder: 'h', renewedAt: 'whenever', minutes: 60 } },
    });

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.detected).toBe(1);
    expect(result.leasesReleased).toBe(0);
    const strand = await strandOf(issueId);
    expect(strand?.lease).toBe('malformed');
    expect(String(strand?.reason)).toContain('renewedAt is not a parseable timestamp');
    expect((await leaseOf(issueId))?.stopped).toBeUndefined();
  });
});

describe('What the write must not disturb', () => {
  it('leaves `updated_at` at the value it had, so a swept row does not read as freshly worked', async () => {
    const issueId = await seedIssue({ status: 'developed' });
    const read = async () => {
      const rows = (await fx.db.execute(sql`
          SELECT updated_at::text AS at FROM issues WHERE id = ${issueId}
        `)) as unknown as Array<{ at: string }>;
      return rows[0]?.at;
    };
    const before = await read();

    await mods.reconcileIdleIssues(NOW);

    expect(await read()).toBe(before);
    expect(await strandOf(issueId)).not.toBeNull();
  });

  it('refuses the write where the lease moved between the read and the write', async () => {
    const issueId = await seedIssue({
      status: 'in_progress',
      sessionContext: { lease: lease({ renewedAt: '2026-09-20T09:37:00.000Z' }) },
    });

    let renewed = false;
    betweenReadAndWrite = async () => {
      renewed = true;
      await fx.db.execute(sql`
          UPDATE issues
             SET session_context = jsonb_set(session_context, '{lease,renewedAt}',
                                             to_jsonb('2026-09-20T15:59:00.000Z'::text))
           WHERE id = ${issueId}
        `);
    };

    const result = await mods.reconcileIdleIssues(NOW);

    expect(renewed).toBe(true);
    expect(result.leasesReleased).toBe(0);
    const held = await leaseOf(issueId);
    expect(held?.renewedAt).toBe('2026-09-20T15:59:00.000Z');
    expect(held?.stopped).toBeUndefined();
    expect(await strandOf(issueId)).toBeNull();
  });

  it('writes the lease keys only, so another key of session_context survives', async () => {
    const issueId = await seedIssue({
      status: 'in_progress',
      sessionContext: {
        lease: lease({ renewedAt: '2026-09-20T09:37:00.000Z' }),
        branch: 'iss-1105-worklog',
      },
    });

    await mods.reconcileIdleIssues(NOW);

    const rows = (await fx.db.execute(sql`
        SELECT session_context FROM issues WHERE id = ${issueId}
      `)) as unknown as Array<{ session_context: Record<string, unknown> }>;
    expect(rows[0]?.session_context?.branch).toBe('iss-1105-worklog');
    expect(rows[0]?.session_context?.strand).toBeDefined();
  });
});

describe('The finding does not outlive what it claims', () => {
  it.each([
    ['a live job arrives', async (id: string) => addLiveJob(id)],
    [
      'the status moves to one at rest',
      async (id: string) =>
        void (await fx.db.execute(sql`UPDATE issues SET status='on_hold' WHERE id=${id}`)),
    ],
    [
      'the row goes terminal',
      async (id: string) =>
        void (await fx.db.execute(
          sql`UPDATE issues SET status='closed', merged_at=${LONG_AGO_TS}::timestamptz WHERE id=${id}`,
        )),
    ],
  ])('clears a finding once %s', async (_name, recover) => {
    const issueId = await seedIssue({ status: 'in_progress' });
    await mods.reconcileIdleIssues(NOW);
    expect(await strandOf(issueId)).not.toBeNull();

    await recover(issueId);
    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.cleared).toBe(1);
    expect(await strandOf(issueId)).toBeNull();
  });

  it('appends one swept entry however many passes read the released lease', async () => {
    const issueId = await seedIssue({
      status: 'in_progress',
      sessionContext: { lease: lease({ renewedAt: '2026-09-20T09:37:00.000Z' }) },
    });

    await mods.reconcileIdleIssues(NOW);
    const second = await mods.reconcileIdleIssues(new Date('2026-09-20T16:01:00.000Z'));
    await mods.reconcileIdleIssues(new Date('2026-09-20T16:02:00.000Z'));

    expect(second.leasesReleased).toBe(0);
    const history = (await leaseOf(issueId))?.history as Array<Record<string, unknown>>;
    expect(history.filter((e) => e.how === 'swept')).toHaveLength(1);
  });

  it('does not rewrite an unchanged finding, so `at` says when it was first recorded', async () => {
    const issueId = await seedIssue({ status: 'developed' });

    await mods.reconcileIdleIssues(NOW);
    const first = await strandOf(issueId);
    await mods.reconcileIdleIssues(new Date('2026-09-20T17:30:00.000Z'));

    expect(await strandOf(issueId)).toEqual(first);
    expect(first?.at).toBe(NOW.toISOString());
  });

  /**
   * The consult's F3 — a row that MOVED carries a finding written at the status it left, and the
   * status it is at now has a clock of its own that has not run out. Holding the old finding
   * through that clock shows progress as a standing failure.
   */
  it('clears a finding when the row moves to a status still inside its own grace', async () => {
    const issueId = await seedIssue({ status: 'in_progress' });
    await mods.reconcileIdleIssues(NOW);
    expect((await strandOf(issueId))?.status).toBe('in_progress');

    await fx.db.execute(sql`
      UPDATE issues SET status='testing', updated_at=${NOW.toISOString()}::timestamptz
       WHERE id=${issueId}
    `);
    const result = await mods.reconcileIdleIssues(new Date('2026-09-20T16:05:00.000Z'));

    expect(result.cleared).toBe(1);
    expect(await strandOf(issueId)).toBeNull();
  });

  /**
   * The consult's F1 — the recovery arm writes only to the rows it clears, so a page full of rows
   * that are still stranded would be re-read every tick and hide every row behind them for ever.
   */
  it('walks past a full page of rows that stay stranded to reach one that recovered', async () => {
    await fx.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id,
                          session_context, created_at, updated_at)
      SELECT gen_random_uuid(), ${fx.projectId}, 3000 + g, 'wedged', 'in_progress', 'medium',
             ${fx.ownerId},
             jsonb_build_object('strand', jsonb_build_object('status', 'in_progress')),
             ${LONG_AGO_TS}::timestamptz, ${LONG_AGO_TS}::timestamptz
        FROM generate_series(1, 200) g
    `);
    const recovered = await seedIssue({
      status: 'closed',
      mergedAt: LONG_AGO_TS,
      updatedAt: '2026-09-19T00:00:00.000Z',
    });
    await fx.db.execute(sql`
      UPDATE issues
         SET session_context = jsonb_build_object('strand', jsonb_build_object('status','closed'))
       WHERE id = ${recovered}
    `);

    const first = await mods.reconcileIdleIssues(NOW);
    expect(first.cleared).toBe(0);
    expect(await strandOf(recovered)).not.toBeNull();

    const second = await mods.reconcileIdleIssues(NOW);

    expect(second.cleared).toBe(1);
    expect(await strandOf(recovered)).toBeNull();
  });

  it('leaves the finding standing while the row is still stranded', async () => {
    const issueId = await seedIssue({ status: 'in_progress' });
    await mods.reconcileIdleIssues(NOW);
    const first = await strandOf(issueId);

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.cleared).toBe(0);
    expect(await strandOf(issueId)).toEqual(first);
  });
});

describe('An automatic release hold decides what an awaiting_release strand says (ISS-1215)', () => {
  it('takes owner, wait and reason from the hold, and keeps the person-owned reading without one', async () => {
    const waitingFor = 'a verdict on each criterion named, at the runtime serving it';
    const releaseHold = {
      code: 'RELEASE_CRITERIA_UNEARNED',
      reason: 'criterion 3: unjudged',
      owes: 'agent',
      waitingFor,
    };
    const merged = '2026-09-14T00:00:00.000Z';
    const held = await seedIssue({
      status: 'awaiting_release',
      mergedAt: merged,
      sessionContext: { releaseHold },
    });
    const unheld = await seedIssue({ status: 'awaiting_release', mergedAt: merged });

    await mods.reconcileIdleIssues(NOW);

    const strand = await strandOf(held);
    expect([strand?.owes, strand?.waitingFor]).toEqual(['agent', waitingFor]);
    expect(String(strand?.reason)).toContain('(RELEASE_CRITERIA_UNEARNED): criterion 3: unjudged');
    const plain = await strandOf(unheld);
    expect([plain?.owes, plain?.waitingFor]).toEqual(['human', 'a person to release it']);
  });

  it('closes a hold reason that ends in a full stop with that one full stop', async () => {
    const releaseHold = {
      code: 'RELEASE_CRITERIA_UNEARNED',
      reason: 'criterion 3: no verdict was recorded for it. A person clears this.',
      owes: 'human',
      waitingFor: 'a verdict on each criterion named at the running deployment',
    };
    await seedIssue({
      status: 'awaiting_release',
      mergedAt: '2026-09-14T00:00:00.000Z',
      sessionContext: { releaseHold },
    });

    await mods.reconcileIdleIssues(NOW);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.body).toContain('A person clears this. It is waiting for');
    expect(emitted[0]?.body).not.toContain('..');
    expect(emitted[0]?.body).toContain('a person owes the next move');
  });
});
