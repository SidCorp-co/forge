/**
 * Migration 0681, run by drizzle's own migrator over the rows a deploy can find (ISS-1251 round 5):
 * the lessons map's example read `Lessons applied: L-3, L-7`, and forge-dev's only applications were
 * that pair, once each, by the steward. An output whose applications are exactly its project's
 * lessons 3 and 7 is marked wrongly applied, saying why, and each lesson's count loses it; an output
 * naming 3 and 7 among others, one naming 3 alone, and another project's pair read as they did.
 * Planted red by matching ARRAY[3, 8]: the copied pair stayed unmarked and counted.
 *
 * @direct-test-of packages/core/drizzle/migrations/0681_an_application_copied_from_the_lessons_map_example_is_not_applied.sql
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0681_an_application_copied_from_the_lessons_map_example_is_not_applied';

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let orgId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
  m = await ground.fresh();
  userId = randomUUID();
  orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'agent')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
}, 120_000);

afterAll(async () => {
  await m.drop();
  await ground.drop();
});

async function project(): Promise<string> {
  const id = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${id}, ${`p-${id.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  return id;
}

/** Approved lessons 1..`n` of a project, by number, each applied `applied` times before 0681. */
async function lessons(projectId: string, numbers: number[], applied: Record<number, number>) {
  const ids: Record<number, string> = {};
  for (const n of numbers) {
    const [row] = await m.sql<{ id: string }[]>`
      INSERT INTO lessons (project_id, number, sentence, scope_kind, status, proposed_by, proposed_agency, approved_at, applied_count)
      VALUES (${projectId}, ${n}, ${`Lesson ${n}.`}, 'project', 'approved', ${userId}, 'agent', now(), ${applied[n] ?? 0})
      RETURNING id`;
    ids[n] = row?.id as string;
  }
  return ids;
}

async function applied(projectId: string, lessonId: string, kind: string, ref: string) {
  await m.sql`
    INSERT INTO lesson_applications (project_id, lesson_id, output_kind, output_ref, agent_user_id)
    VALUES (${projectId}, ${lessonId}, ${kind}, ${ref}, ${userId})`;
}

const marks = (projectId: string) =>
  m.sql<{ number: number; output_ref: string; wrong: boolean; reason: string | null }[]>`
    SELECT l.number, la.output_ref, la.wrong_at IS NOT NULL AS wrong, la.wrong_reason AS reason
      FROM lesson_applications la JOIN lessons l ON l.id = la.lesson_id
     WHERE la.project_id = ${projectId} ORDER BY la.output_ref, l.number`;
const counts = async (projectId: string) =>
  Object.fromEntries(
    (
      await m.sql<{ number: number; applied_count: number }[]>`
        SELECT number, applied_count FROM lessons WHERE project_id = ${projectId} ORDER BY number`
    ).map((r) => [r.number, r.applied_count]),
  );

describe('0681: an application copied from the map’s example is not applied', () => {
  it('marks only an output naming exactly lessons 3 and 7, and takes each off its count', async () => {
    const p = await project();
    const ids = await lessons(p, [3, 7, 9], { 3: 2, 7: 1, 9: 1 });
    // the steward's copied line, as forge-dev recorded it
    await applied(p, ids[3] as string, 'steward_run', 'run-copied');
    await applied(p, ids[7] as string, 'steward_run', 'run-copied');
    // a real application of 3 beside 9, and of 3 alone: neither is the example
    await applied(p, ids[3] as string, 'issue', 'iss-real');
    await applied(p, ids[9] as string, 'issue', 'iss-real');
    const other = await project();
    const otherIds = await lessons(other, [3, 7], { 3: 1, 7: 1 });
    await applied(other, otherIds[3] as string, 'chat_message', 'msg-1');
    await applied(other, otherIds[7] as string, 'chat_message', 'msg-1');
    await applied(other, otherIds[7] as string, 'chat_message', 'msg-2');

    await m.migrate();

    const reason =
      "Copied from the lessons map's example `Lessons applied: L-3, L-7`, not applied (ISS-1251)";
    expect(await marks(p)).toEqual([
      { number: 3, output_ref: 'iss-real', wrong: false, reason: null },
      { number: 9, output_ref: 'iss-real', wrong: false, reason: null },
      { number: 3, output_ref: 'run-copied', wrong: true, reason },
      { number: 7, output_ref: 'run-copied', wrong: true, reason },
    ]);
    expect(await counts(p)).toEqual({ 3: 1, 7: 0, 9: 1 });
    // every project's copy is marked, and an output naming 7 alone is not one
    expect((await marks(other)).map((r) => [r.output_ref, r.number, r.wrong])).toEqual([
      ['msg-1', 3, true],
      ['msg-1', 7, true],
      ['msg-2', 7, false],
    ]);
    expect(await counts(other)).toEqual({ 3: 0, 7: 0 });
  });
});
