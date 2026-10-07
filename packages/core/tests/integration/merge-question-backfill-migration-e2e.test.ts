/**
 * Migration 0453's backfill, `forge_answer_marked_questions`: an open question whose awaited issue
 * already carries its merge mark is answered naming the mark, recorded as a kernel move and on the
 * parked issue, and named in a NOTICE with the park still to move; a question whose mark is still owed
 * stays open; a second run answers nothing.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0453_a_question_names_the_merge_mark_it_waits_on';
const MARKED_AT = new Date('2026-10-06T18:32:02.000Z');

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;
let seq = 0;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  await m.migrate();
  userId = randomUUID();
  const orgId = randomUUID();
  projectId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

async function issue(status: string, mark: { sha?: string } | null = null): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await m.sql.begin(async (tx) => {
    await tx`SELECT set_config('forge.kernel_txn', txid_current()::text, true)`;
    await tx`
      INSERT INTO issues (id, project_id, iss_seq, title, status, waiting_kind, created_by_id, merged_at, merged_commit_sha)
      VALUES (${id}, ${projectId}, ${seq}, 'planted', ${status},
              ${status === 'needs_info' ? 'needs_decision' : null}, ${userId},
              ${mark ? MARKED_AT : null}, ${mark?.sha ?? null})
    `;
  });
  return id;
}

async function question(parked: string, awaited: string): Promise<string> {
  const id = randomUUID();
  const steps = [
    {
      round: 1,
      prompt: 'parked until the landing is recorded',
      askedAt: '2026-10-06T18:00:00.000Z',
      answerShape: 'free_text',
      needed: 'the merge mark',
    },
  ];
  await m.sql`
    INSERT INTO agent_questions (id, project_id, issue_id, blocker_kind, steps, awaits_merge_issue_id)
    VALUES (${id}, ${projectId}, ${parked}, 'human', ${m.sql.json(steps)}, ${awaited})
  `;
  return id;
}

/** Run the backfill as a later deploy would, on a client that hears its NOTICEs. */
async function backfill(): Promise<{ answered: number; notices: string[] }> {
  const [named] = await m.sql<Array<{ db: string }>>`SELECT current_database() AS db`;
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? '');
  url.pathname = `/${named?.db}`;
  const notices: string[] = [];
  const client = postgres(url.toString(), {
    max: 1,
    onnotice: (n) => notices.push(String(n.message)),
  });
  try {
    const [row] = await client<Array<{ n: number }>>`
      SELECT forge_answer_marked_questions('a later stamp') AS n`;
    return { answered: Number(row?.n), notices };
  } finally {
    await client.end({ timeout: 5 });
  }
}

const questionRow = async (id: string) =>
  (
    await m.sql<Array<{ status: string; answer: string | null; by: string | null }>>`
      SELECT status, steps -> -1 ->> 'answerText' AS answer, steps -> -1 ->> 'answeredBy' AS by
        FROM agent_questions WHERE id = ${id}`
  )[0];

describe('an open question whose awaited mark already stands', () => {
  it('is answered naming the mark, recorded, and named with its park; a mark still owed is left', async () => {
    const landed = await issue('in_progress', { sha: 'a'.repeat(40) });
    const owed = await issue('in_progress');
    const parked = await issue('needs_info');
    const answered = await question(parked, landed);
    const waiting = await question(parked, owed);

    const first = await backfill();
    expect(first.answered).toBe(1);
    expect(await questionRow(answered)).toEqual({
      status: 'answered',
      answer: `The merge mark of ISS-${seq - 2} was recorded: commit ${'a'.repeat(40)} at 2026-10-06T18:32:02.000Z.`,
      by: userId,
    });
    expect((await questionRow(waiting))?.status).toBe('open');

    const moves = await m.sql<Array<{ to_status: string; source: string; actor_id: string }>>`
      SELECT to_status, source, actor_id FROM kernel_transitions WHERE entity_id = ${answered}`;
    expect(moves).toEqual([{ to_status: 'answered', source: 'migration', actor_id: userId }]);
    const records = await m.sql<Array<{ fields: Array<{ key: string; value: string }> }>>`
      SELECT payload -> 'fields' AS fields FROM activity_log
       WHERE issue_id = ${parked} AND action = 'record.answer'`;
    expect(records).toHaveLength(1);
    expect(records[0]?.fields).toContainEqual({ key: 'question', value: answered });

    const said = first.notices.join('\n');
    expect(said).toContain(`answered 1: question ${answered}, awaiting ISS-${seq - 2}`);
    expect(said).toContain(`still parked, a migration returns no park`);
    expect(said).toContain(parked);
    expect(said).not.toContain(waiting);

    const second = await backfill();
    expect(second.answered).toBe(0);
    expect(second.notices.join('\n')).toContain('answered 0: none');
  });
});

describe('the migration file itself', () => {
  it('runs again over its own result without error and answers nothing new', async () => {
    const text = readFileSync(
      new URL(`../../drizzle/migrations/${TAG}.sql`, import.meta.url),
      'utf8',
    );
    for (const statement of text.split('--> statement-breakpoint')) {
      if (statement.trim()) await m.sql.unsafe(statement);
    }
    expect((await backfill()).answered).toBe(0);
  });
});
