import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { registerIdleFixture } from '../helpers/idle-fixture.js';

vi.mock('../../src/notifications/emit.js', () => ({
  emitNotification: async () => ({ delivered: 1 }),
}));
vi.mock('../../src/notifications/project-admins.js', () => ({
  projectAdminUserIdsFor: async (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, [`admin-of-${id}`]])),
  projectAdminUserIds: async () => ['admin'],
}));

/**
 * ISS-1122 — `live-work.ts` now holds the three probes that say whether anything is working an
 * issue, for `idle-issues.ts` and for `issue-run-invariant.ts` alike.
 *
 * `detectOrphanedRunAssertions` had no test of any kind, and this change moved those probes out of
 * its query. A textually identical fragment is still only a claim about SQL, so the claim is made
 * here: the pass fires where it fired before, and each probe holds it back on its own.
 */
const fx = registerIdleFixture(1400);
const NOW = new Date('2026-09-20T16:00:00.000Z');

const seedIssue = (status: string) => fx.seedIssue({ status });
const seedRun = (issueId: string | null, status: string) => fx.seedRun(issueId, status);

async function orphans(): Promise<number> {
  const { detectOrphanedRunAssertions } = await import('../../src/pipeline/issue-run-invariant.js');
  return (await detectOrphanedRunAssertions(NOW)).detected;
}

async function idle(): Promise<number> {
  const { reconcileIdleIssues } = await import('../../src/pipeline/idle-issues.js');
  return (await reconcileIdleIssues(NOW)).detected;
}

describe('detectOrphanedRunAssertions keeps its predicate across the extraction (ISS-1122)', () => {
  it('still finds an `in_progress` row with nothing live behind it', async () => {
    await seedIssue('in_progress');
    expect(await orphans()).toBe(1);
  });

  it('still ignores a status it never watched', async () => {
    await seedIssue('developed');
    expect(await orphans()).toBe(0);
  });

  it('is still held back by a live run', async () => {
    const issueId = await seedIssue('releasing');
    await seedRun(issueId, 'running');
    expect(await orphans()).toBe(0);
  });

  it.each(['running', 'paused'])('is still held back by a %s issue run', async (status) => {
    const issueId = await seedIssue('testing');
    await seedRun(issueId, status);
    expect(await orphans()).toBe(0);
    expect(await idle()).toBe(0);
  });

  it.each(['running', 'paused'])(
    'is still held back by a %s system run naming the issue',
    async (status) => {
      await seedIssue('in_progress');
      await fx.seedSystemRun(fx.lastSeq, status);
      expect(await orphans()).toBe(0);
      expect(await idle()).toBe(0);
    },
  );
});

/**
 * The job probe on its own.
 *
 * A live job normally sits under a live run, so the run probe alone would hold both passes back
 * and a broken job probe would go unnoticed. The state that separates them is a job still running
 * under a run that has gone terminal — the very orphan the INV-1 cascade exists to clear. It is
 * reached by flipping the run AFTER the job is inserted: the trigger that would have cancelled the
 * job fires on the job row, not on the run's.
 */
describe('the job probe holds on its own (ISS-1122)', () => {
  async function jobUnderTerminalRun(status: string): Promise<void> {
    const issueId = await seedIssue(status);
    const runId = await fx.seedLiveJob(issueId);
    await fx.db.execute(sql`UPDATE pipeline_runs SET status='completed' WHERE id=${runId}`);
  }

  it('holds detectOrphanedRunAssertions back with no live run to help it', async () => {
    await jobUnderTerminalRun('in_progress');
    expect(await orphans()).toBe(0);
  });

  it('holds reconcileIdleIssues back with no live run to help it', async () => {
    await jobUnderTerminalRun('developed');
    expect(await idle()).toBe(0);
  });
});

/** The two passes this change was told not to alter, read at the source. */
describe('the existing detectors keep their predicates (ISS-1122)', () => {
  it('keeps `waiting` on detectStrandedIssues and the merge mark on detectOwedCloses', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../src/pipeline/stranded-issues.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain("eq(issues.status, 'waiting')");
    expect(source).toContain('isNotNull(issues.mergedAt)');
  });
});
