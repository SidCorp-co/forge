/**
 * ISS-1229 r14, judge-35's reader note on 90: an In progress issue with no run was named an orphan at
 * ten minutes and idle two hours later, so the bell held it in two groups and the headline counted ten
 * for eight issues. A stuck issue is told once, under its most specific reason, and the health read
 * counts it once. Each case was planted against the old sweeps and seen red before the fix.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const fx = registerInboxFixture();
const HOUR = 3_600_000;

async function issue(
  seq: number,
  status: string,
  hoursAgo: number,
  merged = false,
): Promise<string> {
  const id = randomUUID();
  const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  await fx.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, waiting_kind,
                        merged_at, created_at, updated_at)
    VALUES (${id}, ${fx.project.id}, ${`issue ${seq}`}, ${status}, ${fx.owner}, ${seq},
            ${status === 'waiting' ? 'needs_decision' : null}, ${merged ? at : null},
            ${at}::timestamptz, ${at}::timestamptz)
  `);
  return id;
}

/** A sweep run until it tells somebody: a stuck-issue condition waits two evaluations. */
async function announce(sweep: () => Promise<unknown>) {
  await sweep();
  await fx.db.execute(sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`);
  await sweep();
}

/** The issue's standing stuck-issue notices, by the suffix of the sweep that raised each. */
async function standing(issueId: string): Promise<string[]> {
  const rows = (await fx.db.execute(sql`
    SELECT regexp_replace(resolution_key, '^issue:[^:]+:', '') AS sweep
      FROM notifications
     WHERE issue_id = ${issueId} AND type = 'issue_stranded' AND resolved_at IS NULL
       AND state IN ('pending', 'firing', 'inhibited')
     ORDER BY 1
  `)) as unknown as Array<{ sweep: string }>;
  return rows.map((r) => r.sweep);
}

async function sweeps() {
  const { reconcileIdleIssues } = await import('../../src/pipeline/idle-issues.js');
  const { detectOrphanedRunAssertions } = await import('../../src/pipeline/issue-run-invariant.js');
  const { detectOwedCloses, detectStrandedIssues } = await import(
    '../../src/pipeline/stranded-issues.js'
  );
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
  return {
    reconcileIdleIssues,
    detectOrphanedRunAssertions,
    detectOwedCloses,
    detectStrandedIssues,
  };
}

describe('one issue, one stuck reason', () => {
  it('tells an In progress issue with no run as an orphan, never also as idle', async () => {
    const orphan = await issue(1, 'in_progress', 3);
    const s = await sweeps();

    // Told as idle first, the orphan sweep that tells it more specifically ends the idle notice itself.
    await announce(() => s.reconcileIdleIssues(new Date()));
    await announce(() => s.detectOrphanedRunAssertions(new Date()));

    expect(await standing(orphan)).toEqual(['run-assertion-orphaned']);
    // And the idle sweep running again raises nothing beside it.
    await s.reconcileIdleIssues(new Date());
    expect(await standing(orphan)).toEqual(['run-assertion-orphaned']);
    const { readHealthAggregates } = await import('../../src/projects/health-aggregates.js');
    const { stuckIssueRows } = await readHealthAggregates([fx.project.id]);
    expect(stuckIssueRows.map((r) => [r.kind, r.total, r.byKind])).toEqual([
      ['orphan', 1, { orphan: 1 }],
    ]);
  });

  it('tells a shipped issue parked for a person as waiting, never also as owed a close', async () => {
    const parked = await issue(2, 'waiting', 8, true);
    const s = await sweeps();

    await announce(() => s.detectOwedCloses(new Date()));
    await announce(() => s.detectStrandedIssues(new Date()));

    expect(await standing(parked)).toEqual(['stranded']);
    await s.detectOwedCloses(new Date());
    expect(await standing(parked)).toEqual(['stranded']);
    const rows = fx.sweepRows(await fx.inbox()).filter((r) => r.openMembers > 0);
    expect(rows.map((r) => r.title)).toEqual([
      expect.stringContaining('waiting for your decision'),
    ]);
  });

  it('counts each stuck issue once in the headline’s kinds, adding up to the stuck total', async () => {
    await issue(3, 'in_progress', 3);
    await issue(4, 'in_progress', 3);
    await issue(5, 'open', 1);
    const s = await sweeps();
    await announce(() => s.reconcileIdleIssues(new Date()));
    await announce(() => s.detectOrphanedRunAssertions(new Date()));

    const { readHealthAggregates } = await import('../../src/projects/health-aggregates.js');
    const [row] = (await readHealthAggregates([fx.project.id])).stuckIssueRows;
    expect(row?.total).toBe(3);
    expect(row?.byKind).toEqual({ orphan: 2, idle: 1 });
  });
});
