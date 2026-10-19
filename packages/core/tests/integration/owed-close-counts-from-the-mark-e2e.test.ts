/**
 * ISS-1229 r16 — judge-41: the owed-close notice said "carried a merge mark for 7 hours" of a mark
 * four minutes old. It counted from `merged_at`, when the code merged, and a mark read off the
 * repository carries that commit's time. Migration 0339 stores when the mark was set, the one merge
 * writer stamps it, and the sweep counts from it: six hours after the mark, never after the commit.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let stranded: typeof import('../../src/pipeline/stranded-issues.js');
let merge: typeof import('../../src/issues/merge-record.js');
let client: typeof import('../../src/db/client.js');

const HOUR = 3_600_000;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';
  stranded = await import('../../src/pipeline/stranded-issues.js');
  merge = await import('../../src/issues/merge-record.js');
  client = await import('../../src/db/client.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let projectId = '';
let ownerId = '';

beforeEach(async () => {
  await truncateAll(harness.db);
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id, { name: 'Ledger' })).id;
});

/** A Developed issue whose code merged `mergedHoursAgo` ago, marked through the one merge writer. */
async function markedIssue(mergedHoursAgo: number): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, iss_seq, created_at, updated_at)
    VALUES (${id}, ${projectId}, 'Export the ledger', 'developed', ${ownerId}, 7,
            now() - interval '3 days', now() - interval '3 days')
  `);
  const wrote = await merge.recordIssueMerge(client.db, {
    issueId: id,
    evidence: {
      kind: 'observed',
      commitSha: 'a'.repeat(40),
      mergedAt: new Date(Date.now() - mergedHoursAgo * HOUR),
      via: 'repository',
    },
  });
  expect(wrote.wrote).toBe(true);
  return id;
}

async function noticeOf(issueId: string): Promise<{ body: string } | undefined> {
  const [row] = (await harness.db.execute(sql`
    SELECT body FROM notifications
     WHERE issue_id = ${issueId} AND type = 'issue_stranded' AND resolution_key LIKE '%:owed-close'
  `)) as unknown as Array<{ body: string }>;
  return row;
}

describe('the owed-close notice counts from when the mark was set', () => {
  it('raises nothing for a mark minutes old on code merged hours before', async () => {
    const id = await markedIssue(7);
    await stranded.detectOwedCloses(new Date());
    expect(await noticeOf(id)).toBeUndefined();
  });

  it('says how long the mark has stood, not how long ago the code merged', async () => {
    const id = await markedIssue(72);
    await harness.db.execute(sql`
      UPDATE issues SET merge_marked_at = now() - interval '7 hours' WHERE id = ${id}
    `);
    await stranded.detectOwedCloses(new Date());
    expect((await noticeOf(id))?.body).toBe(
      'ISS-7 "Export the ledger" has carried a merge mark for 7 hours while it still reads Developed, with nothing running on it.',
    );
  });

  it('counts a mark made before the moment was stored from the merge, as it did', async () => {
    const id = await markedIssue(8);
    await harness.db.execute(sql`UPDATE issues SET merge_marked_at = NULL WHERE id = ${id}`);
    await stranded.detectOwedCloses(new Date());
    expect((await noticeOf(id))?.body).toContain('has carried a merge mark for 8 hours');
  });

  it('clears the moment with the mark', async () => {
    const id = await markedIssue(1);
    expect(await merge.clearIssueMerge(client.db, id)).toBe(true);
    const [row] = (await harness.db.execute(sql`
      SELECT merge_marked_at FROM issues WHERE id = ${id}
    `)) as unknown as Array<{ merge_marked_at: string | null }>;
    expect(row?.merge_marked_at).toBeNull();
  });
});
