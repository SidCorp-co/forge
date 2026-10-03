/**
 * ISS-1257 — migration 0311 voids the open questions left standing on finished work.
 *
 * The migration's own text is read from its file rather than restated, so what
 * is proved is what runs at the deploy. The template database already carries
 * it, so each case plants rows the migration would have met and runs it again:
 * the statement is a set update over the current rows, and running it twice is
 * what a redeploy does anyway.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL('../../drizzle/migrations/0311_questions_die_with_their_issue.sql', import.meta.url),
);

let harness: TestDatabase;
let projectId: string;
let userId: string;
let seq = 0;

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, userId)).id;
});

async function issue(status: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, waiting_kind, created_by_id, merged_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status},
            ${status === 'needs_info' ? 'needs_answer' : null}, ${userId}, now())
  `);
  return id;
}

async function question(issueId: string, status: 'open' | 'answered'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps)
    VALUES (${id}, ${projectId}, ${issueId}, ${status}, 'human', '[{"round":1}]'::jsonb)
  `);
  return id;
}

async function row(id: string) {
  const rows = await harness.db.execute(sql`
    SELECT status, void_reason AS "voidReason", ended_by AS "endedBy",
           ended_reason AS "endedReason", steps, updated_at AS "updatedAt"
    FROM agent_questions WHERE id = ${id}
  `);
  return rows[0] as {
    status: string;
    voidReason: string | null;
    endedBy: string | null;
    endedReason: string | null;
    steps: unknown;
    updatedAt: Date;
  };
}

async function runMigration() {
  for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) await harness.db.execute(sql.raw(statement));
  }
}

describe('migration 0311', () => {
  it('voids every open question on a closed or dropped issue, naming the status it reached', async () => {
    const onClosed = await question(await issue('closed'), 'open');
    const onDropped = await question(await issue('dropped'), 'open');

    await runMigration();

    for (const [id, status] of [
      [onClosed, 'closed'],
      [onDropped, 'dropped'],
    ] as const) {
      const r = await row(id);
      expect(r.status).toBe('void');
      expect(r.voidReason).toContain(`\`${status}\``);
      expect(r.endedBy).toBe('migration:0311');
      expect(r.endedReason).toBe('issue_terminal');
      expect(r.steps).toEqual([{ round: 1 }]);
    }
    const left = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM agent_questions q JOIN issues i ON i.id = q.issue_id
      WHERE q.status = 'open' AND i.status IN ('closed', 'dropped')
    `);
    expect((left[0] as { n: number }).n).toBe(0);
  });

  it('leaves an answered question and an open question on live work exactly as they were', async () => {
    const answered = await question(await issue('closed'), 'answered');
    const live = await question(await issue('needs_info'), 'open');
    const before = [await row(answered), await row(live)];

    await runMigration();

    expect([await row(answered), await row(live)]).toEqual(before);
  });
});
