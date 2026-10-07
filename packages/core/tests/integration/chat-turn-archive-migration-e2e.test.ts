/**
 * Migrations 0394 and 0448, run by drizzle's own migrator over the rows a deploy can find. Production
 * still holds chat_logs, 576 turns that are the only per-turn record of what people asked and what the
 * assistant did; promotion runs 0394, which drops the table, in the same batch as every later file.
 * The turns are copied into chat_turn_archive before the drop, and a database that ran 0394 before
 * the copy existed gets the same table from 0448.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const DROP = '0394_features_with_no_design_and_no_use_are_dropped';
const STANDS = '0448_the_chat_turn_archive_stands_where_0394_already_ran';

const COLUMNS = [
  'archived_at',
  'created_at',
  'duration_ms',
  'error',
  'id',
  'iterations',
  'model',
  'project_id',
  'project_slug',
  'query',
  'reply',
  'session_id',
  'source',
  'tool_calls',
  'usage',
  'user_key',
];

async function project(m: MigrationDb): Promise<{ id: string; slug: string }> {
  const userId = randomUUID();
  const orgId = randomUUID();
  const id = randomUUID();
  const slug = `p-${id.slice(0, 8)}`;
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${id}, ${slug}, 'P', ${orgId}, ${userId})`;
  return { id, slug };
}

async function columns(m: MigrationDb): Promise<string[]> {
  const rows = await m.sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'chat_turn_archive'
     ORDER BY column_name
  `;
  return rows.map((r) => r.column_name);
}

describe('0394: the chat audit log is archived before it is dropped', () => {
  let ground: MigrationGround;
  let m: MigrationDb;

  beforeAll(async () => {
    ground = await groundBefore(DROP);
  }, 180_000);
  afterAll(async () => {
    await ground.drop();
  });
  beforeEach(async () => {
    m = await ground.fresh();
  });
  afterEach(async () => {
    await m.drop();
  });

  it('keeps every turn, answered, failed and orphaned, with what the analysis reads', async () => {
    const p = await project(m);
    const answered = randomUUID();
    const failed = randomUUID();
    const orphaned = randomUUID();
    const tools = JSON.stringify([
      { name: 'forge', arguments: '{"argv":["issue","--status","open"]}', isError: false },
    ]);
    await m.sql`
      INSERT INTO chat_logs (id, session_id, project_slug, user_key, query, reply, model, tool_calls,
                             usage, iterations, duration_ms, error, source, created_at)
      VALUES
        (${answered}, 's-1', ${p.slug}, 'person-a', 'dev', 'Dev: 10 in progress, 14 not started.',
         'model-x', ${tools}::text::jsonb, '{"totalTokens": 13288}'::jsonb, 2, 5352, NULL, 'web',
         '2026-09-16T15:19:55Z'),
        (${failed}, 's-2', ${p.slug}, 'person-b', 'close ISS-744, I no longer need it', NULL,
         'model-x', NULL, NULL, 3, 90000, 'This operation was aborted', 'rocketchat',
         '2026-10-01T02:00:00Z'),
        (${orphaned}, NULL, 'a-project-since-deleted', NULL, 'status?', 'All done.', NULL, NULL,
         NULL, 1, 1200, NULL, 'web', '2026-07-03T08:00:00Z')
    `;

    await m.migrate();

    const left = await m.sql`SELECT to_regclass('public.chat_logs') AS t`;
    expect(left[0]?.t).toBeNull();
    const rows = await m.sql<
      {
        id: string;
        project_id: string | null;
        source: string;
        query: string;
        error: string | null;
        duration_ms: number;
        iterations: number;
        first_tool: string | null;
      }[]
    >`SELECT id, project_id, source, query, error, duration_ms, iterations,
             tool_calls->0->>'name' AS first_tool
        FROM chat_turn_archive ORDER BY created_at`;
    expect(rows.map((r) => r.id)).toEqual([orphaned, answered, failed]);
    expect(rows.map((r) => r.project_id)).toEqual([null, p.id, p.id]);
    expect(rows[1]).toMatchObject({
      source: 'web',
      duration_ms: 5352,
      iterations: 2,
      first_tool: 'forge',
    });
    expect(rows[2]).toMatchObject({ source: 'rocketchat', error: 'This operation was aborted' });
    expect(await columns(m)).toEqual(COLUMNS);
  });

  it("deletes a project's archived turns with the project", async () => {
    const p = await project(m);
    await m.sql`
      INSERT INTO chat_logs (session_id, project_slug, query, iterations, source)
      VALUES ('s-1', ${p.slug}, 'hello', 1, 'web')
    `;
    await m.migrate();
    await m.sql`DELETE FROM projects WHERE id = ${p.id}`;
    const rows = await m.sql`SELECT 1 FROM chat_turn_archive`;
    expect(rows).toHaveLength(0);
  });
});

describe('0448: every database carries the archive, whichever 0394 it ran', () => {
  let ground: MigrationGround;
  let m: MigrationDb;

  beforeAll(async () => {
    ground = await groundBefore(STANDS);
  }, 240_000);
  afterAll(async () => {
    await ground.drop();
  });
  beforeEach(async () => {
    m = await ground.fresh();
  });
  afterEach(async () => {
    await m.drop();
  });

  it('creates the archive, the same table 0394 creates, where 0394 ran without the copy', async () => {
    await m.sql`DROP TABLE chat_turn_archive`;
    await m.migrate();
    expect(await columns(m)).toEqual(COLUMNS);
  });

  it('leaves an archive 0394 already filled as it is', async () => {
    const p = await project(m);
    const id = randomUUID();
    await m.sql`
      INSERT INTO chat_turn_archive (id, project_id, project_slug, source, query, iterations, created_at)
      VALUES (${id}, ${p.id}, ${p.slug}, 'web', 'hello', 1, now())
    `;
    await m.migrate();
    const rows = await m.sql`SELECT id FROM chat_turn_archive`;
    expect(rows.map((r) => r.id)).toEqual([id]);
  });
});
