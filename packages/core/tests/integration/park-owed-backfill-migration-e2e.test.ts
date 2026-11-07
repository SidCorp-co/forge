/**
 * Migration 0632, run by drizzle's own migrator over the open park questions a deploy finds
 * (ISS-1127): each one whose park waits on no person moves off `human` and is named in a NOTICE — its
 * own merge mark to `machine`, a resource park or another issue named in `needed` to
 * `master_or_peer` — and a person's answer, a comment's question and a question someone asked keep
 * theirs. A park question that says nothing of what would settle it, and waits on no mark, stays a
 * person's and is named in a NOTICE; nothing aborts the deploy.
 *
 * @direct-test-of packages/core/drizzle/migrations/0632_a_park_question_is_owed_by_what_it_waits_on.sql
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0632_a_park_question_is_owed_by_what_it_waits_on';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
let userId: string;
let seq = 60;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  userId = randomUUID();
  const orgId = randomUUID();
  projectId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO issue_prefix_aliases (project_id, prefix) VALUES (${projectId}, 'EPOD')`;
  await m.sql`UPDATE projects SET issue_prefix = 'EPOD' WHERE id = ${projectId}`;
});

afterEach(async () => {
  await m.drop();
});

async function parked(waitingKind: string, status = 'needs_info'): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, waiting_kind)
      VALUES (${id}, ${projectId}, ${seq}, 'planted', ${status}, ${userId}, ${waitingKind})`;
  });
  return id;
}

async function asked(
  issueId: string,
  needed: string | null,
  more: { mergeOf?: string; askedBy?: string; id?: string } = {},
): Promise<string> {
  const id = more.id ?? randomUUID();
  const step = {
    round: 1,
    prompt: 'What settles this park?',
    askedAt: new Date().toISOString(),
    answerShape: 'free_text',
    ...(needed === null ? {} : { needed }),
  };
  await m.sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps, awaits_merge_issue_id, asked_by)
    VALUES (${id}, ${projectId}, ${issueId}, 'open', 'human', ${m.sql.json([step])},
            ${more.mergeOf ?? null}, ${more.askedBy ?? null})`;
  return id;
}

const kindOf = async (id: string) =>
  String((await m.sql`SELECT blocker_kind FROM agent_questions WHERE id = ${id}`)[0]?.blocker_kind);

describe('0632 moves each open park question that waits on no person off it', () => {
  it('moves a resource park, another issue named and a merge mark, naming each; keeps a person’s', async () => {
    const resource = await parked('needs_resource');
    const onResource = await asked(resource, 'forge ISS-1125, the production monitor');
    const decision = await parked('needs_decision');
    const onOther = await asked(decision, 'EPOD-9000 landed first');
    const answer = await parked('needs_answer');
    const onMark = await asked(answer, `the merge mark of EPOD-${seq}`, { mergeOf: answer });
    const person = await parked('needs_decision');
    const onPerson = await asked(person, `which group EPOD-${seq} mirrors, and who decided`);
    const byDoor = await asked(resource, 'a token', { askedBy: userId });
    const commentId = randomUUID();
    await m.sql`INSERT INTO comments (id, issue_id, author_id, body) VALUES (${commentId}, ${person}, ${userId}, 'ISS-77?')`;
    const onComment = await asked(person, 'ISS-77, answered here', { id: commentId });

    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));

    expect(await kindOf(onResource)).toBe('master_or_peer');
    expect(await kindOf(onOther)).toBe('master_or_peer');
    expect(await kindOf(onMark)).toBe('machine');
    expect(await kindOf(onPerson)).toBe('human');
    expect(await kindOf(byDoor)).toBe('human');
    expect(await kindOf(onComment)).toBe('human');
    const said = notices.join('\n');
    expect(said).toContain(`${onResource} on EPOD-`);
    expect(said).toContain('it waits on a resource');
    expect(said).toContain(`${onOther} on EPOD-`);
    expect(said).toContain('it waits on EPOD-9000');
    expect(said).toContain(`${onMark} on EPOD-`);
    expect(said).toContain('3 park question(s) moved off a person');
    expect(said).not.toContain(onPerson);
  });

  it('places a merge-mark park with no `needed` as the machine’s, and leaves a mute one a person’s, naming it, never aborting', async () => {
    const merged = await parked('needs_answer');
    const onMark = await asked(merged, null, { mergeOf: merged });
    const issue = await parked('needs_decision');
    const mute = await asked(issue, null);
    const notices: string[] = [];
    await m.migrate((n) => notices.push(n));
    expect(await kindOf(onMark)).toBe('machine');
    expect(await kindOf(mute)).toBe('human');
    const said = notices.join('\n');
    expect(said).toMatch(
      new RegExp(`0632: park question ${onMark} on EPOD-\\d+ moved from human to machine`),
    );
    expect(said).toMatch(
      new RegExp(
        `0632: park question ${mute} on EPOD-\\d+ left human: nothing says what settles it`,
      ),
    );
  });
});
