/**
 * Migration 0428, run by drizzle's own migrator over the rows a deploy can find: the never-written
 * agent_sessions.pipeline_control goes, and a row that still holds a value aborts the deploy naming
 * that row rather than deleting it unread.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0428_the_never_written_session_pipeline_control_is_dropped';

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;
let runId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  userId = randomUUID();
  projectId = randomUUID();
  runId = randomUUID();
  const orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}, 'interactive', 'running')`;
});

afterEach(async () => {
  await m.drop();
});

async function session(control: string | null): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, pipeline_control)
    VALUES (${id}, ${projectId}, ${userId}, ${runId}, 'chat', 'completed', ${control}::jsonb)
  `;
  return id;
}

async function hasColumn(): Promise<boolean> {
  const rows = await m.sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'agent_sessions' AND column_name = 'pipeline_control'
  `;
  return rows.length > 0;
}

describe('0428: agent_sessions.pipeline_control is dropped', () => {
  it('drops the column where no row holds a value, and keeps every row', async () => {
    const id = await session(null);
    await m.migrate();
    expect(await hasColumn()).toBe(false);
    const rows = await m.sql`SELECT id FROM agent_sessions WHERE id = ${id}`;
    expect(rows).toHaveLength(1);
  });

  it('aborts naming the row that still holds a value, and leaves the column and the value', async () => {
    const id = await session('{"paused": true}');
    const refused = await m.migrate().then(
      () => null,
      (err: unknown) => err,
    );
    // drizzle wraps the database's own error as the cause of its "Failed query"
    const said = String((refused as { cause?: { message?: string } } | null)?.cause?.message);
    expect(said).toContain(`agent_sessions ${id} holds a pipeline_control value`);
    expect(await hasColumn()).toBe(true);
  });
});
