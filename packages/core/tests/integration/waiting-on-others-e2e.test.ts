/**
 * ISS-1229 r16 — judge-41 on criterion 98: an Owner who administers a project read a Member's parks
 * as "Has been waiting for you", counted among "issues waiting for you", and the bell said "ISS-2 is
 * waiting for your decision". The master's ruling: "you" only where the reader owes the park; for
 * anyone else the row and the bell name who owes it, and the headline counts the two apart.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../helpers/factories.js';
import { registerInboxFixture } from '../helpers/inbox-fixture.js';

const fx = registerInboxFixture();
const HOUR = 3_600_000;

async function park(seq: number, filedBy: string, assignee: string | null = null): Promise<string> {
  const id = randomUUID();
  const at = new Date(Date.now() - 8 * HOUR).toISOString();
  await fx.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, assignee_id, iss_seq, waiting_kind,
                        created_at, updated_at)
    VALUES (${id}, ${fx.project.id}, ${`park ${seq}`}, 'waiting', ${filedBy}, ${assignee}, ${seq},
            'needs_decision', ${at}::timestamptz, ${at}::timestamptz)
  `);
  return id;
}

async function member(name: string): Promise<string> {
  const user = await createTestUser(fx.db);
  await fx.db.execute(sql`UPDATE users SET display_name = ${name} WHERE id = ${user.id}`);
  await fx.db.execute(sql`
    INSERT INTO project_members (project_id, user_id, role) VALUES (${fx.project.id}, ${user.id}, 'member')
  `);
  return user.id;
}

/** The stranded sweep run until it tells somebody: a stuck-issue condition waits two evaluations. */
async function announce() {
  const { detectStrandedIssues } = await import('../../src/pipeline/stranded-issues.js');
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
  await detectStrandedIssues(new Date());
  await fx.db.execute(sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`);
  await detectStrandedIssues(new Date());
}

describe("another person's park, read by a project admin who does not owe it", () => {
  it('is told as waiting for that person, on the headline, the row and the bell', async () => {
    const mai = await member('Mai');
    const own = await park(1, fx.owner);
    const hers = await park(2, mai);
    const assigned = await park(3, fx.owner, mai);
    await announce();

    const { readHealthAggregates } = await import('../../src/projects/health-aggregates.js');
    const { stuckIssueRows } = await readHealthAggregates([fx.project.id], fx.owner);
    expect(stuckIssueRows[0]?.byKind).toEqual({ waiting: 1, waiting_on_others: 2 });
    const told = new Map(stuckIssueRows.map((r) => [r.id, [r.kind, r.owedBy]]));
    expect(told.get(own)).toEqual(['waiting', null]);
    expect(told.get(hers)).toEqual(['waiting_on_others', 'Mai']);
    expect(told.get(assigned)).toEqual(['waiting_on_others', 'Mai']);

    const { readStuckKinds } = await import('../../src/projects/stuck-kinds-read.js');
    const kinds = await readStuckKinds([own, hers], fx.owner);
    expect(kinds.get(own)).toEqual({ kind: 'waiting' });
    expect(kinds.get(hers)).toEqual({ kind: 'waiting_on_others', owedBy: 'Mai' });

    const [group] = fx.sweepRows(await fx.inbox());
    expect(group?.title).toBe('Issues that have been waiting for a person for over six hours');
    const titles = (await fx.membersOf(group?.id ?? '')).map((m) => m.title).sort();
    expect(titles).toEqual([
      'ISS-1 is waiting for your decision — Invoicing',
      "ISS-2 is waiting for Mai's decision — Invoicing",
      "ISS-3 is waiting for Mai's decision — Invoicing",
    ]);
  });

  it('is told to the person who owes it as theirs', async () => {
    const mai = await member('Mai');
    const hers = await park(2, mai);
    await announce();

    const { readHealthAggregates } = await import('../../src/projects/health-aggregates.js');
    const { stuckIssueRows } = await readHealthAggregates([fx.project.id], mai);
    expect(stuckIssueRows.map((r) => [r.id, r.kind, r.owedBy])).toEqual([[hers, 'waiting', null]]);

    const { waitingTitlesFor } = await import('../../src/notifications/waiting-titles.js');
    const [notice] = (await fx.db.execute(sql`
      SELECT id FROM notifications WHERE issue_id = ${hers} AND type = 'issue_stranded'
    `)) as unknown as Array<{ id: string }>;
    expect((await waitingTitlesFor(mai, [notice?.id ?? ''])).get(notice?.id ?? '')).toBe(
      'ISS-2 is waiting for your decision — Invoicing',
    );
  });
});
