import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIdleFixture, testHeartbeat, testLease } from '../helpers/idle-fixture.js';

/** Every notification this pass emitted, so what it SAYS is assertable and not just that it said. */
const emitted: Array<{ title: string; body: string }> = [];
vi.mock('../../src/notifications/emit.js', () => ({
  emitNotification: async (args: { title: string; body: string }) => {
    emitted.push({ title: args.title, body: args.body });
    return { delivered: 1 };
  },
}));
vi.mock('../../src/notifications/project-admins.js', () => ({
  projectAdminUserIdsFor: async (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, [`admin-of-${id}`]])),
  projectAdminUserIds: async () => ['admin'],
}));

const fx = registerIdleFixture(1500);
const NOW = new Date('2026-09-20T16:00:00.000Z');

let mods: {
  reconcileIdleIssues: (
    now?: Date,
    scope?: { projectId?: string },
  ) => Promise<{ detected: number; leasesReleased: number; cleared: number }>;
};

beforeAll(async () => {
  mods = (await import('../../src/pipeline/idle-issues.js')) as unknown as typeof mods;
}, 60_000);

beforeEach(async () => {
  emitted.length = 0;
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

const seedIssue = (args: Parameters<typeof fx.seedIssue>[0]) => fx.seedIssue(args);
const lease = testLease;

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

/**
 * ISS-1195 — the one condition the pass above cannot see: a lease inside its own term whose holder
 * has stopped reporting.
 *
 * Measured on ISS-1127 on 2026-09-23. The lease read `live: session ae8dc932 … renewed 18:27 for 90
 * minute(s)` while no process on the box carried that session id, no scratchpad file recorded it,
 * and the run's worktree had not been written for nearly two hours. The row was locked for ninety
 * minutes after its holder died and every legitimate reclaim was refused.
 *
 * The clock here is the one that was measured rather than the fixture's `LONG_AGO`: a row last
 * written twenty minutes ago, holding a ninety-minute lease renewed then. Seeded at `LONG_AGO` the
 * release would pass on the status grace alone and prove nothing about the heartbeat.
 */
describe('A holder that stopped reporting (ISS-1195)', () => {
  const DIED_AT = '2026-09-20T15:40:00.000Z';

  const silent = (over: Record<string, unknown> = {}) =>
    lease({ minutes: 90, renewedAt: DIED_AT, heartbeat: testHeartbeat(), ...over });

  const seedSilentRow = (over: Record<string, unknown> = {}) =>
    seedIssue({
      status: 'in_progress',
      updatedAt: DIED_AT,
      sessionContext: { lease: silent(over) },
    });

  it('reaches a row whose lease has not run out and whose holder has gone silent', async () => {
    const issueId = await seedSilentRow();

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.detected).toBe(1);
    expect((await strandOf(issueId))?.lease).toBe('abandoned');
  });

  it('releases it on the heartbeat, without waiting out the status grace or moving the row', async () => {
    const issueId = await seedSilentRow();

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.leasesReleased).toBe(1);
    const held = await leaseOf(issueId);
    expect(held?.stopped).toBe(NOW.toISOString());
    const history = held?.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[1]?.how).toBe('swept');

    const rows = (await fx.db.execute(sql`
      SELECT status FROM issues WHERE id = ${issueId}
    `)) as unknown as Array<{ status: string }>;
    expect(rows[0]?.status).toBe('in_progress');
  });

  it('says the holder stopped reporting, and how long ago, rather than that the claim expired', async () => {
    const issueId = await seedSilentRow();

    await mods.reconcileIdleIssues(NOW);

    const reason = String((await strandOf(issueId))?.reason);
    expect(reason).toContain('stopped reporting');
    expect(reason).toContain('20 minute');
    expect(reason).not.toContain('expiry');
  });

  it('tells the reader nothing is working it, not that nothing could be confirmed', async () => {
    await seedSilentRow();

    await mods.reconcileIdleIssues(NOW);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.title).toContain('nothing is working it');
    expect(emitted[0]?.title).not.toContain('could be confirmed');
  });

  it('reads every row of a silent holder as abandoned rather than merely shared', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await seedSilentRow({ holder: 'wave-66a33b93' }));

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.leasesReleased).toBe(3);
    for (const id of ids) expect((await strandOf(id))?.lease).toBe('abandoned');
  });

  it('is still held back by the fleet-wide guard, which this reading does not reach past', async () => {
    const issueId = await seedSilentRow();
    await fx.seedIssueLease(fx.lastSeq, 'running');

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.detected).toBe(0);
    expect(await strandOf(issueId)).toBeNull();
    expect((await leaseOf(issueId))?.stopped).toBeUndefined();
  });

  /**
   * The review's F1. `clearRecovered` walks on a cursor of its own, so it reads rows on ticks the
   * scan did not, and the row here is inside the scan's own fifteen-minute window — the finding
   * would be cleared on this tick and written again on a later one. A row whose holder is gone has
   * not progressed, whatever status it now reads, so the move is not evidence against the finding.
   */
  it('keeps the finding on a row that moved while its holder is still gone', async () => {
    const issueId = await seedSilentRow({ stopped: undefined });
    await fx.db.execute(sql`
      UPDATE issues
         SET status = 'testing',
             updated_at = ${NOW.toISOString()}::timestamptz,
             session_context = session_context || ${JSON.stringify({
               strand: { status: 'in_progress', lease: 'abandoned' },
             })}::jsonb
       WHERE id = ${issueId}
    `);

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.cleared).toBe(0);
    expect((await strandOf(issueId))?.status).toBe('in_progress');
  });

  it('leaves a beating holder alone', async () => {
    const issueId = await seedSilentRow({ heartbeat: testHeartbeat({ at: NOW.toISOString() }) });

    const result = await mods.reconcileIdleIssues(NOW);

    expect(result.detected).toBe(0);
    expect(await strandOf(issueId)).toBeNull();
  });

  it('does not release the same silent lease twice', async () => {
    const issueId = await seedSilentRow();

    await mods.reconcileIdleIssues(NOW);
    const again = await mods.reconcileIdleIssues(NOW);

    expect(again.leasesReleased).toBe(0);
    const history = (await leaseOf(issueId))?.history as Array<Record<string, unknown>>;
    expect(history.filter((h) => h.how === 'swept')).toHaveLength(1);
  });

  /**
   * F4 on this issue's plan consult: were an unreadable heartbeat to reach `leaseIsUnexpired`, the
   * row WITHOUT one would drop out of its holder's fanout and change verdict — a lease carrying no
   * heartbeat behaving differently because another row does.
   */
  it('leaves the fanout of a heartbeat-less lease where it was when a sibling carries a bad one', async () => {
    const plain = await seedIssue({
      status: 'in_progress',
      sessionContext: { lease: lease({ holder: 'mixed-holder' }) },
    });
    const bad = await seedIssue({
      status: 'in_progress',
      sessionContext: { lease: lease({ holder: 'mixed-holder', heartbeat: { at: 'whenever' } }) },
    });

    const result = await mods.reconcileIdleIssues(NOW);

    expect((await strandOf(plain))?.lease).toBe('shared');
    expect((await strandOf(bad))?.lease).toBe('malformed');
    expect(result.leasesReleased).toBe(0);
  });
});
