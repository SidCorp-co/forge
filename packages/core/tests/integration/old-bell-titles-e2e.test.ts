/**
 * ISS-1229 r17, judge-44: a status-change notice titled before round 16 still read "moved to
 * needs_info" in the bell. Migration 0341 words those titles; its own text is read from its file, so
 * what is proved is what runs at the deploy. The template database already carries it, so each case
 * plants the rows it would have met and runs it again.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const MIGRATION = fileURLToPath(
  new URL(
    '../../drizzle/migrations/0341_an_old_bell_row_names_a_status_as_the_screen_does.sql',
    import.meta.url,
  ),
);

let harness: TestDatabase;
let userId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
});

/** A record and the bell row that told it, both carrying `title`. */
async function told(type: string, title: string, groupKey: string | null = null) {
  const [record] = (await harness.db.execute(sql`
    INSERT INTO notifications (type, kind, tier, state, title)
    VALUES (${type}, 'signal', 'log', 'emitted', ${title})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [delivery] = (await harness.db.execute(sql`
    INSERT INTO notification_deliveries (user_id, title, group_key)
    VALUES (${userId}, ${title}, ${groupKey})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  await harness.db.execute(sql`
    INSERT INTO notification_delivery_members (delivery_id, notification_id)
    VALUES (${delivery?.id}, ${record?.id})
  `);
  return { recordId: record?.id ?? '', deliveryId: delivery?.id ?? '' };
}

async function titles(ids: { recordId: string; deliveryId: string }) {
  const [r] = (await harness.db.execute(
    sql`SELECT title FROM notifications WHERE id = ${ids.recordId}`,
  )) as unknown as Array<{ title: string }>;
  const [d] = (await harness.db.execute(
    sql`SELECT title FROM notification_deliveries WHERE id = ${ids.deliveryId}`,
  )) as unknown as Array<{ title: string }>;
  return [r?.title, d?.title];
}

async function runMigration() {
  for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) await harness.db.execute(sql.raw(statement));
  }
}

describe('migration 0341: an old status-change title names the status as the screen does', () => {
  it('words every stored status a title ends in, on the record and its bell row', async () => {
    const cases = {
      needs_info: await told('issue_status_changed', 'ISS-22 — Fix the export moved to needs_info'),
      awaiting_release: await told('issue_status_changed', 'ISS-23 moved to awaiting_release'),
      reopen: await told('issue_status_changed', 'ISS-24 — reopen it moved to reopen'),
      open: await told('issue_status_changed', 'ISS-25 moved to open'),
    };
    await runMigration();
    expect(await titles(cases.needs_info)).toEqual([
      'ISS-22 — Fix the export moved to Needs info',
      'ISS-22 — Fix the export moved to Needs info',
    ]);
    expect(await titles(cases.awaiting_release)).toEqual([
      'ISS-23 moved to Awaiting release',
      'ISS-23 moved to Awaiting release',
    ]);
    expect(await titles(cases.reopen)).toEqual([
      'ISS-24 — reopen it moved to Reopened',
      'ISS-24 — reopen it moved to Reopened',
    ]);
    expect(await titles(cases.open)).toEqual(['ISS-25 moved to Open', 'ISS-25 moved to Open']);
  });

  it('leaves a title already worded, another type, a grouped row and a word that is no status', async () => {
    const worded = await told('issue_status_changed', 'ISS-26 moved to Needs info');
    const other = await told('mention', 'ISS-27 moved to closed');
    const grouped = await told('issue_status_changed', 'Three issues moved to closed', 'g:1');
    const notStatus = await told('issue_status_changed', 'ISS-28 moved to the next room');
    await runMigration();
    expect(await titles(worded)).toEqual(['ISS-26 moved to Needs info', 'ISS-26 moved to Needs info']);
    expect(await titles(other)).toEqual(['ISS-27 moved to closed', 'ISS-27 moved to closed']);
    expect((await titles(grouped))[1]).toBe('Three issues moved to closed');
    expect(await titles(notStatus)).toEqual([
      'ISS-28 moved to the next room',
      'ISS-28 moved to the next room',
    ]);
  });

  it('changes nothing on a second run', async () => {
    const once = await told('issue_status_changed', 'ISS-29 moved to on_hold');
    await runMigration();
    await runMigration();
    expect(await titles(once)).toEqual(['ISS-29 moved to On hold', 'ISS-29 moved to On hold']);
  });
});
