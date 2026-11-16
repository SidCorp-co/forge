/**
 * Migration 0678, run by drizzle's own migrator over the rows a deploy can find (ISS-1251 c9): a
 * lesson a landing held invalid before it read, by its slug, as `verified`. Its knowledge entry is
 * now `deprecated` and names when and what touched it, from its own lesson row; an approved lesson's
 * entry and one held by a confusion, never invalidated, read as they did. The audit log gains the
 * session a box write was made in, null for every row already there.
 * Planted red by running the migrator with the UPDATE matching no lesson: lesson-1 read verified.
 *
 * @direct-test-of packages/core/drizzle/migrations/0678_a_box_write_names_its_session_and_an_invalid_lesson_reads_invalid.sql
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0678_a_box_write_names_its_session_and_an_invalid_lesson_reads_invalid';
const BY = 'ISS-1251 changed packages/core/src/support/tool-description.ts';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;
let userId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
  m = await ground.fresh();
  userId = randomUUID();
  const orgId = randomUUID();
  projectId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'agent')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO mcp_audit_log (user_id, tool, action, result_code) VALUES (${userId}, 'rest', 'POST /api/x', 'ok')`;
}, 120_000);

afterAll(async () => {
  await m.drop();
  await ground.drop();
});

/** A lesson and its entry as they stood before 0678: every entry `verified`. */
async function lesson(number: number, status: 'approved' | 'held', invalid: boolean) {
  const at = invalid ? new Date('2026-11-16T18:20:47.245Z') : null;
  await m.sql`
    INSERT INTO lessons (project_id, number, sentence, scope_kind, status, proposed_by, proposed_agency, approved_at, invalid_at, invalid_by)
    VALUES (${projectId}, ${number}, ${`Lesson ${number}.`}, 'project', ${status}, ${userId}, 'agent', now(), ${at}, ${invalid ? BY : null})`;
  await m.sql`
    INSERT INTO knowledge_entries (project_id, slug, title, body, kind, injection, confidence, authored_by, metadata)
    VALUES (${projectId}, ${`lesson-${number}`}, ${`L-${number}`}, ${`Lesson ${number}.`}, 'lesson',
            ${status === 'approved' ? 'on_demand' : 'none'}, 'verified', 'agent', ${m.sql.json({ number })})`;
}

const entry = async (number: number) =>
  (
    await m.sql<{ confidence: string; injection: string; metadata: Record<string, unknown> }[]>`
      SELECT confidence, injection, metadata FROM knowledge_entries
      WHERE project_id = ${projectId} AND slug = ${`lesson-${number}`}`
  )[0];

describe('0678: a lesson held invalid reads as invalid by its slug', () => {
  it('marks only the held invalid lessons’ entries, from their own rows, and adds the audit column', async () => {
    await lesson(1, 'held', true);
    await lesson(2, 'approved', false);
    await lesson(3, 'held', false);
    await m.migrate();

    expect(await entry(1)).toEqual({
      confidence: 'deprecated',
      injection: 'none',
      metadata: { number: 1, invalid: true, invalidAt: '2026-11-16T18:20:47.245Z', invalidBy: BY },
    });
    expect(await entry(2)).toEqual({
      confidence: 'verified',
      injection: 'on_demand',
      metadata: { number: 2 },
    });
    expect(await entry(3)).toEqual({
      confidence: 'verified',
      injection: 'none',
      metadata: { number: 3 },
    });
    const audit = await m.sql`SELECT agent_session_id FROM mcp_audit_log`;
    expect(audit.map((r) => r.agent_session_id)).toEqual([null]);
  });
});
