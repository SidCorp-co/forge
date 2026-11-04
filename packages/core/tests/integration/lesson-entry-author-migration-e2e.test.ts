/**
 * Migration 0601, run by drizzle's own migrator over the rows a deploy can find (REQ-50 BC-2,
 * decision 4ca95ce9 on REQ-50): every `kind = 'lesson'` knowledge entry still reading `authored_by =
 * 'human'` (a lesson's own `lesson-<n>`, or a month's figures) reads `agent`, since the steward decides
 * every lesson; an entry of any other kind a person wrote keeps `human`, and an imported one keeps
 * `imported`. Planted red by running the migrator with the UPDATE left out: the lesson row stayed human.
 *
 * @direct-test-of packages/core/drizzle/migrations/0601_a_lesson_entry_is_the_agents.sql
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0601_a_lesson_entry_is_the_agents';

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

/** A knowledge entry as a write before 0601 left it. */
async function entry(slug: string, kind: string, authoredBy: string): Promise<void> {
  await m.sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body, injection, confidence, authored_by)
    VALUES (${projectId}, ${kind}, ${slug}, ${slug}, 'Body.', 'on_demand', 'verified', ${authoredBy})`;
}

async function authorOf(slug: string): Promise<string | undefined> {
  const [row] = await m.sql`
    SELECT authored_by FROM knowledge_entries WHERE project_id = ${projectId} AND slug = ${slug}`;
  return row?.authored_by as string | undefined;
}

describe('0601: a lesson entry is the agent’s', () => {
  it('flips each lesson entry a person was recorded on to the agent, and leaves every other entry', async () => {
    await entry('lesson-1', 'lesson', 'human');
    await entry('lesson-2', 'lesson', 'agent');
    await entry('lessons-month-2026-10', 'lesson', 'human');
    await entry('build-commands', 'guide', 'human');
    await entry('imported-rule', 'rule', 'imported');
    await m.migrate();
    expect(await authorOf('lesson-1')).toBe('agent');
    expect(await authorOf('lesson-2')).toBe('agent');
    expect(await authorOf('lessons-month-2026-10')).toBe('agent');
    expect(await authorOf('build-commands')).toBe('human');
    expect(await authorOf('imported-rule')).toBe('imported');
  });

  it('applies to a project holding no lesson, changing nothing', async () => {
    await entry('build-commands', 'guide', 'human');
    await m.migrate();
    expect(await authorOf('build-commands')).toBe('human');
  });
});
