/**
 * ISS-1229 r13 repair — the project headline, the bell and Attention count the same stuck work. On
 * one board they read three numbers nobody could reconcile. Here one fixture is read through all
 * three, and each count is held to the one reading they share: what each stuck-issue notice says.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const fx = registerInboxFixture();
const { inbox, membersOf } = fx;
const HOUR = 3_600_000;

async function issue(seq: number, status: string, hoursAgo: number): Promise<string> {
  const id = randomUUID();
  const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  await fx.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, waiting_kind, created_at, updated_at)
    VALUES (${id}, ${fx.project.id}, ${`issue ${seq}`}, ${status}, ${fx.owner}, ${seq},
            ${status === 'waiting' ? 'needs_decision' : null}, ${at}::timestamptz, ${at}::timestamptz)
  `);
  return id;
}

/** A sweep run until it tells somebody: a stuck-issue condition waits two evaluations. */
async function announce(sweep: () => Promise<unknown>) {
  await sweep();
  await fx.db.execute(sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`);
  await sweep();
}

describe('one board read through the headline, the bell and Attention', () => {
  it('counts the same stuck issues by what each notice says, on every surface', async () => {
    const parkedLong = [
      await issue(1, 'waiting', 7),
      await issue(2, 'waiting', 8),
      await issue(3, 'waiting', 9),
    ];
    const parkedRecently = await issue(4, 'waiting', 1);
    const idle = [await issue(5, 'open', 1), await issue(6, 'open', 2)];

    const { detectStrandedIssues } = await import('../../src/pipeline/stranded-issues.js');
    const { reconcileIdleIssues } = await import('../../src/pipeline/idle-issues.js');
    const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
    resetSweepCursorsForTest();
    await announce(() => detectStrandedIssues(new Date()));
    await announce(() => reconcileIdleIssues(new Date()));

    // The headline's count, by kind.
    const { readHealthAggregates } = await import('../../src/projects/health-aggregates.js');
    const { stuckIssueRows } = await readHealthAggregates([fx.project.id]);
    expect(stuckIssueRows[0]?.total).toBe(5);
    expect(stuckIssueRows[0]?.byKind).toEqual({ waiting: 3, idle: 2 });

    // The bell's groups: what each says it holds, and which issues.
    const { detectorOfGroupKey, SWEEP_DETECTORS } = await import(
      '../../src/notifications/explanations.js'
    );
    const rows = (await inbox()).items.filter((r) => r.type === 'issue_stranded');
    const held = async (detector: string) => {
      const ids: string[] = [];
      for (const r of rows.filter((row) => detectorOfGroupKey(row.groupKey) === detector)) {
        for (const m of await membersOf(r.id)) if (m.open && m.issueId) ids.push(m.issueId);
      }
      return ids.sort();
    };
    expect(await held('stranded')).toEqual([...parkedLong].sort());
    expect(await held('idle-issues')).toEqual([...idle].sort());
    expect(SWEEP_DETECTORS.stranded.groupTitle).toBe('Issues waiting for you for over six hours');

    // Attention: every park the reader owes an answer, however long; past six hours, the bell's.
    const { selectAwaitingInput } = await import('../../src/me/attention-buckets.js');
    const awaiting = await selectAwaitingInput(fx.owner);
    expect(awaiting.map((a) => a.id).sort()).toEqual([...parkedLong, parkedRecently].sort());
    const pastSix = awaiting.filter((a) => Date.now() - a.waitingSince.getTime() > 6 * HOUR);
    expect(pastSix.map((a) => a.id).sort()).toEqual(await held('stranded'));
  });
});
