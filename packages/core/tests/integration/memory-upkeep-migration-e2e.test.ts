/**
 * Migration 0630 (ISS-1121, REQ-89 BC-3), run by drizzle's own migrator over the rows 0458 left:
 * memory's upkeep records leave the memories table for `memory_upkeep_records`, kept as history,
 * a memory someone wrote stays where it is, and a bookkeeping row of a cause neither upkeep job
 * writes aborts the deploy naming it, with nothing moved. A knowledge entry's rewrite keeps the text
 * it replaced.
 *
 * @direct-test-of packages/core/drizzle/migrations/0630_memory_upkeep_leaves_memory_and_knowledge_keeps_its_revisions.sql
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0630_memory_upkeep_leaves_memory_and_knowledge_keeps_its_revisions';

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
  const orgId = randomUUID();
  projectId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
});

afterEach(async () => {
  await m.drop();
});

async function memory(source: string, ref: string, metadata: object): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO memories (id, project_id, source, source_ref, text_content, metadata)
    VALUES (${id}, ${projectId}, ${source}, ${ref}, ${`text of ${ref}`}, ${m.sql.json(metadata as never)})
  `;
  return id;
}

async function refusal(): Promise<string> {
  try {
    await m.migrate();
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
  return 'migrated';
}

describe('0630: memory upkeep leaves the memories table', () => {
  it('moves each upkeep record to the history table by its cause, keeps a written memory, and says how many', async () => {
    await memory('bookkeeping', 'reconcile:ISS-3', { cause: 'memory-reconcile', issueId: 'x' });
    await memory('bookkeeping', 'consolidation:2026-10-06-ab12cd34', {
      cause: 'memory-consolidation',
    });
    const note = await memory('note', 'gotcha/theme', { why: 'kept' });
    const notices: string[] = [];

    await m.migrate((n) => notices.push(n));

    const left = await m.sql<{ id: string; source: string }[]>`
      SELECT id, source FROM memories WHERE project_id = ${projectId}`;
    expect(left).toEqual([{ id: note, source: 'note' }]);
    const moved = await m.sql<{ kind: string; ref: string; text_content: string }[]>`
      SELECT kind, ref, text_content FROM memory_upkeep_records WHERE project_id = ${projectId} ORDER BY ref`;
    expect(moved).toEqual([
      {
        kind: 'consolidation',
        ref: 'consolidation:2026-10-06-ab12cd34',
        text_content: 'text of consolidation:2026-10-06-ab12cd34',
      },
      { kind: 'reconcile', ref: 'reconcile:ISS-3', text_content: 'text of reconcile:ISS-3' },
    ]);
    expect(notices).toContain('0630: 2 bookkeeping memor(ies) moved to memory_upkeep_records');
  });

  it('aborts naming a bookkeeping row of neither upkeep cause, and moves nothing', async () => {
    const bad = await memory('bookkeeping', 'sweep:2026-11-01', { cause: 'a-hand-sweep' });
    await memory('bookkeeping', 'reconcile:ISS-4', { cause: 'memory-reconcile' });
    expect(await refusal()).toMatch(
      new RegExp(`0630: bookkeeping memory ${bad} .*has cause a-hand-sweep`),
    );
    const left =
      await m.sql`SELECT 1 FROM memories WHERE project_id = ${projectId} AND source = 'bookkeeping'`;
    expect(left).toHaveLength(2);
  });

  it('keeps the text a knowledge rewrite replaced, and refuses a type that is none of the three', async () => {
    await m.migrate();
    const [entry] = await m.sql<{ id: string }[]>`
      INSERT INTO knowledge_entries (project_id, kind, slug, title, body, entry_type)
      VALUES (${projectId}, 'rule', 'one-source', 'One source', 'the old text', 'convention')
      RETURNING id`;
    await m.sql`UPDATE knowledge_entries SET body = 'the new text' WHERE id = ${entry?.id ?? ''}`;
    await m.sql`UPDATE knowledge_entries SET injection = 'always' WHERE id = ${entry?.id ?? ''}`;
    const kept = await m.sql<{ body: string; entry_type: string }[]>`
      SELECT body, entry_type FROM knowledge_entry_revisions WHERE entry_id = ${entry?.id ?? ''}`;
    expect(kept).toEqual([{ body: 'the old text', entry_type: 'convention' }]);
    await expect(
      m.sql`UPDATE knowledge_entries SET entry_type = 'rumour' WHERE id = ${entry?.id ?? ''}`,
    ).rejects.toThrow(/knowledge_entries_entry_type_chk/);
  });
});
