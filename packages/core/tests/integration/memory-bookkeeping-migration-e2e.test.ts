/**
 * Migration 0458, run by drizzle's own migrator over the rows the old code left: memory's upkeep
 * records (metadata.cause memory-reconcile / memory-consolidation) leave `decision` for
 * `bookkeeping`, a decision someone made stays a decision, and a "possibly stale" flag with no
 * reason is dropped and kept as `flagDropped`. Run a second time it changes nothing, and a row the
 * new source cannot represent aborts the deploy naming it.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';
import { MIGRATIONS_FOLDER } from '../helpers/migrations.js';

const TAG = '0458_memory_upkeep_records_are_bookkeeping_and_a_stale_flag_carries_its_reason';

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

async function row(id: string) {
  const [r] = await m.sql<Array<{ source: string; metadata: Record<string, unknown> }>>`
    SELECT source, metadata FROM memories WHERE id = ${id}
  `;
  return r;
}

/** The file's statements run again, by hand: the migrator itself never re-applies a recorded tag. */
async function runAgain(): Promise<void> {
  const text = readFileSync(`${MIGRATIONS_FOLDER}/${TAG}.sql`, 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    if (statement.trim()) await m.sql.unsafe(statement);
  }
}

/** The migrator's refusal with the database's own message, which drizzle carries as the cause. */
async function refusal(): Promise<string> {
  try {
    await m.migrate();
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
  return 'migrated';
}

const RECONCILE = { cause: 'memory-reconcile', issueId: randomUUID(), staleRefs: [] };
const CONSOLIDATION = { cause: 'memory-consolidation', archivedRefs: [] };

describe('0458: memory upkeep records are bookkeeping', () => {
  it('moves each upkeep record by its cause, keeps a real decision, and says how many', async () => {
    const reconcile = await memory('decision', 'reconcile:ISS-3', RECONCILE);
    const consolidation = await memory(
      'decision',
      'consolidation:2026-10-06-ab12cd34',
      CONSOLIDATION,
    );
    const decided = await memory('decision', 'hop-owner-decisions-2026-10-04', { why: 'owner' });
    const notices: string[] = [];

    await m.migrate((n) => notices.push(n));

    expect((await row(reconcile))?.source).toBe('bookkeeping');
    expect((await row(consolidation))?.source).toBe('bookkeeping');
    expect((await row(decided))?.source).toBe('decision');
    expect(notices).toContain(
      '0458: 1 decision memor(ies) with cause memory-reconcile are now bookkeeping',
    );
    expect(notices).toContain(
      '0458: 1 decision memor(ies) with cause memory-consolidation are now bookkeeping',
    );
  });

  it('drops a possibly-stale flag that gives no reason, keeping it as flagDropped, and keeps one that gives one', async () => {
    const silent = await memory('note', 'gotcha/silent', {
      staleSince: '2026-10-07T17:00:00Z',
      supersededBy: 'ISS-126',
      why: 'kept',
    });
    const said = await memory('note', 'gotcha/said', {
      staleSince: '2026-10-07T17:00:00Z',
      supersededBy: 'ISS-126',
      staleReason: 'ISS-126 replaced the store theme this note describes',
    });
    const notices: string[] = [];

    await m.migrate((n) => notices.push(n));

    const s = await row(silent);
    expect(s?.metadata.staleSince).toBeUndefined();
    expect(s?.metadata.supersededBy).toBeUndefined();
    expect(s?.metadata.why).toBe('kept');
    expect(s?.metadata.flagDropped).toEqual({
      since: '2026-10-07T17:00:00Z',
      by: 'ISS-126',
      why: 'flagged possibly stale with no reason given; the flag was dropped (0458)',
    });
    expect((await row(said))?.metadata.staleSince).toBe('2026-10-07T17:00:00Z');
    expect(notices).toContain(
      '0458: 1 possibly-stale flag(s) with no reason were dropped and kept as metadata.flagDropped',
    );
  });

  it('run twice, the second run moves and drops nothing and leaves every row as the first left it', async () => {
    const reconcile = await memory('decision', 'reconcile:ISS-4', RECONCILE);
    const silent = await memory('knowledge', 'k/silent', {
      staleSince: '2026-10-07T17:00:00Z',
      supersededBy: 'ISS-9',
    });
    await m.migrate();
    const first = [await row(reconcile), await row(silent)];

    await runAgain();

    expect([await row(reconcile), await row(silent)]).toEqual(first);
  });

  it.each([
    ['a reconcile ref that is not reconcile:ISS-<n>', 'reconcile:something-else', RECONCILE],
    ['a reconcile row naming no issue', 'reconcile:ISS-5', { cause: 'memory-reconcile' }],
    ['a consolidation ref that is not consolidation:<...>', 'nightly-2026-10-06', CONSOLIDATION],
  ])('aborts naming the row on %s', async (_what, ref, metadata) => {
    const bad = await memory('decision', ref, metadata);
    expect(await refusal()).toMatch(new RegExp(`0458: memory ${bad} .*cannot become bookkeeping`));
    expect((await row(bad))?.source).toBe('decision');
  });

  it('aborts naming the row when a bookkeeping row already holds its ref', async () => {
    await memory('bookkeeping', 'reconcile:ISS-6', RECONCILE);
    const bad = await memory('decision', 'reconcile:ISS-6', RECONCILE);
    expect(await refusal()).toMatch(new RegExp(`0458: memory ${bad} `));
  });
});
