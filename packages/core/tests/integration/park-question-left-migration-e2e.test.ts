/**
 * Migration 0484, run by drizzle's own migrator over the rows the old code left (REQ-41 BC-11). A
 * park's question that outlived its park, as ISS-439's did on dev (parked by the rescue cap, moved
 * back on by a person without an answer, now at `awaiting_release`), is withdrawn and named in the
 * migration's NOTICE; a park the issue still stands in, a question somebody else asked during a
 * park, and a park that adopted the old question when its issue was parked again are left open.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0484_a_park_question_ends_when_its_issue_leaves_the_park';
const CAP_REASON =
  '4 run sessions ended on this issue without it moving on, so it has stopped rather than open another.';

let ground: MigrationGround;
let m: MigrationDb;
let person: string;
let projectId: string;
let slug: string;
let seq = 0;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  person = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${person}, ${`${person}@forge.test`}, '!x', 'human')`;
  const orgId = randomUUID();
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${person})`;
  projectId = randomUUID();
  slug = `p-${projectId.slice(0, 8)}`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${slug}, 'Atlas', ${orgId}, ${person})`;
});

afterEach(async () => {
  await m.drop();
});

const at = (iso: string) => new Date(iso);

async function issue(status: string): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  seq += 1;
  await m.sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, waiting_kind, created_by_id, created_at, priority)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status},
            ${status === 'needs_info' ? 'needs_decision' : null}, ${person}, ${at('2026-10-08T15:00:00Z')}, 'medium')`;
  return { id, key: `ISS-${seq}` };
}

async function move(issueId: string, from: string, to: string, reason: string, when: Date) {
  await m.sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, machine_version, reason, actor_type, actor_agency, actor_id, source, created_at)
    VALUES ('issue', ${issueId}, ${from}, ${to}, 12, ${reason}, 'user', 'agent', ${person}, 'issues', ${when})`;
}

async function question(issueId: string, prompt: string, when: Date): Promise<string> {
  const id = randomUUID();
  const steps = [
    {
      round: 1,
      prompt,
      askedAt: when.toISOString(),
      answerShape: 'free_text',
      needed: 'a decision',
    },
  ];
  await m.sql`
    INSERT INTO agent_questions (id, project_id, issue_id, blocker_kind, steps, created_at, updated_at)
    VALUES (${id}, ${projectId}, ${issueId}, 'human', ${m.sql.json(steps)}, ${when}, ${when})`;
  return id;
}

/** ISS-439's history: parked by the cap with its question, moved back to open by a person, then delivered. */
async function iss439Shape() {
  const parked = at('2026-10-08T19:22:24.304Z');
  const row = await issue('awaiting_release');
  await move(row.id, 'open', 'needs_info', CAP_REASON, parked);
  const q = await question(row.id, CAP_REASON, parked);
  await move(
    row.id,
    'needs_info',
    'open',
    'Design decisions recorded; nothing waits on a person.',
    at('2026-10-08T19:43:17.782Z'),
  );
  await move(row.id, 'open', 'in_progress', '', at('2026-10-08T20:56:33.849Z'));
  await move(
    row.id,
    'in_progress',
    'awaiting_release',
    'QA round 4 holds.',
    at('2026-10-08T23:01:22.960Z'),
  );
  return { ...row, question: q };
}

const questionRow = async (id: string) =>
  (
    await m.sql<
      Array<{
        status: string;
        void_reason: string | null;
        ended_by: string | null;
        ended_reason: string | null;
      }>
    >`
      SELECT status, void_reason, ended_by, ended_reason FROM agent_questions WHERE id = ${id}`
  )[0];

describe('0484: a park question that outlived its park is withdrawn', () => {
  it('withdraws the ISS-439-shaped row, records the move, and names it in the NOTICE', async () => {
    const stale = await iss439Shape();
    const notices: string[] = [];

    await m.migrate((n) => notices.push(n));

    const row = await questionRow(stale.question);
    expect(row?.status).toBe('void');
    expect(row?.ended_by).toBe('migration:0484');
    expect(row?.ended_reason).toBe('park_left');
    expect(row?.void_reason).toContain('the issue left `needs_info` for `open` on 2026-10-08');
    expect(row?.void_reason).toContain('no longer waits on a person');
    expect(row?.void_reason).toContain('Design decisions recorded; nothing waits on a person.');
    const recorded = await m.sql<Array<{ from_status: string; to_status: string; source: string }>>`
      SELECT from_status, to_status, source FROM kernel_transitions
       WHERE entity = 'question' AND entity_id = ${stale.question}`;
    expect(recorded).toEqual([{ from_status: 'open', to_status: 'void', source: 'migration' }]);
    const named = notices.find((n) => n.startsWith('0484: withdrew 1 '));
    expect(named, notices.join('\n')).toContain(
      `question ${stale.question} on ${slug} ${stale.key} (issue now \`awaiting_release\`)`,
    );
  });

  it('leaves a live park, a question somebody else asked, and a re-parked issue open', async () => {
    const live = await issue('needs_info');
    const liveAt = at('2026-10-09T10:00:00Z');
    await move(live.id, 'open', 'needs_info', CAP_REASON, liveAt);
    const liveQ = await question(live.id, CAP_REASON, liveAt);

    const judged = await iss439Shape();
    const judgeQ = await question(
      judged.id,
      'From the judge: is Half half of the large width?',
      at('2026-10-08T19:30:00Z'),
    );

    const again = await issue('needs_info');
    const firstPark = at('2026-10-07T04:31:19.932Z');
    await move(again.id, 'open', 'needs_info', 'Needs a plugin-off pane.', firstPark);
    const adopted = await question(again.id, 'Needs a plugin-off pane.', firstPark);
    await move(
      again.id,
      'needs_info',
      'open',
      'Owner approved the pane.',
      at('2026-10-09T09:49:41.089Z'),
    );
    await move(
      again.id,
      'open',
      'needs_info',
      'Owner ruling cannot be met from the master pane.',
      at('2026-10-09T09:51:50.495Z'),
    );

    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));

    expect((await questionRow(liveQ))?.status).toBe('open');
    expect(
      (await questionRow(judgeQ))?.status,
      'a question asked during the park is its asker’s',
    ).toBe('open');
    expect((await questionRow(judged.question))?.status).toBe('void');
    expect((await questionRow(adopted))?.status, 'the new park waits on it').toBe('open');
    expect(
      notices.find((n) => n.startsWith('0484: left open')),
      notices.join('\n'),
    ).toContain(`question ${adopted} on ${slug} ${again.key}`);
  });

  it('changes nothing when it runs again', async () => {
    const stale = await iss439Shape();
    await m.migrate();
    const before = await questionRow(stale.question);
    expect(before?.status).toBe('void');

    await m.sql.unsafe(
      readFileSync(new URL(`../../drizzle/migrations/${TAG}.sql`, import.meta.url), 'utf8'),
    );

    expect(await questionRow(stale.question)).toEqual(before);
    const recorded = await m.sql`
      SELECT 1 FROM kernel_transitions WHERE entity = 'question' AND entity_id = ${stale.question}`;
    expect(recorded).toHaveLength(1);
  });
});
