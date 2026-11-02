/**
 * Migration 0577, run by drizzle's own migrator over the rows a deploy can find (ISS-867, owner rule
 * prompt-is-a-map): an approved lesson's entry `lesson-<n>` read `injection: always` and every prompt
 * carried its sentence; it now reads `on_demand`, the slug named in the lessons map and the sentence
 * retrieved. A held or retired lesson's `none`, a month's figures and any other entry are left as
 * they were.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0577_a_lesson_is_retrieved_never_injected';

let ground: MigrationGround;
let m: MigrationDb;
let projectId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  const userId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  const orgId = randomUUID();
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  projectId = randomUUID();
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

async function entry(slug: string, kind: string, injection: string): Promise<void> {
  await m.sql`
    INSERT INTO knowledge_entries (project_id, slug, title, body, kind, injection)
    VALUES (${projectId}, ${slug}, ${slug}, ${`Body of ${slug}.`}, ${kind}, ${injection})`;
}

async function injectionOf(slug: string): Promise<string> {
  const [row] = await m.sql`
    SELECT injection FROM knowledge_entries WHERE project_id = ${projectId} AND slug = ${slug}`;
  return row?.injection as string;
}

describe('0577: a lesson is retrieved, never injected', () => {
  it("turns an approved lesson's entry on_demand and leaves every other entry as it was", async () => {
    await entry('lesson-1', 'lesson', 'always');
    await entry('lesson-2', 'lesson', 'none');
    await entry('lessons-month-2026-10', 'lesson', 'on_demand');
    await entry('lessons-month-2026-07', 'lesson', 'none');
    await entry('lesson-guide', 'rule', 'always');
    await entry('ui-copy-rule', 'rule', 'always');
    await m.migrate();
    expect(await injectionOf('lesson-1')).toBe('on_demand');
    expect(await injectionOf('lesson-2')).toBe('none');
    expect(await injectionOf('lessons-month-2026-10')).toBe('on_demand');
    expect(await injectionOf('lessons-month-2026-07')).toBe('none');
    expect(await injectionOf('lesson-guide')).toBe('always');
    expect(await injectionOf('ui-copy-rule')).toBe('always');
  });
});
