/**
 * JU-12: a breakdown files its issues in one statement, so they share a created_at (88 of hop's
 * 132 did). The list ordered by created_at alone, so the rows tied on it came back in a different
 * order on each read, and a reader paging one row at a time — the CLI resolving `ISS-110` by offset —
 * skipped some and reported them absent. Every sort now ends on the issue key and the id.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeWorld, type Doc, ok, requester, testEnv } from '../helpers/ecosystem-world.js';
import { createTestIssue, createTestProject, createTestUser } from '../helpers/factories.js';

let say: ReturnType<typeof requester>;
let projectId = '';
const BATCH = new Date(Date.UTC(2026, 9, 3, 20, 12, 8, 501));
const SORTS = [
  'createdAt:asc',
  'createdAt:desc',
  'updatedAt:asc',
  'updatedAt:desc',
  'priority:asc',
  'priority:desc',
] as const;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const owner = (await createTestUser({ verified: true })).id;
  say = requester(app, { owner: await signUserToken(owner) });
  projectId = (await createTestProject(owner)).id;
  // filed newest key first, so the heap holds the tied rows against key order
  for (const seq of [6, 5, 4, 3, 2, 1]) {
    await createTestIssue(projectId, owner, seq, { status: 'open', createdAt: BATCH });
  }
  await db.execute(
    sql`UPDATE issues SET updated_at = ${BATCH.toISOString()} WHERE project_id = ${projectId}`,
  );
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const pageOf = async (sort: string, offset: number): Promise<string[]> => {
  const body = ok(
    await say(
      'owner',
      'GET',
      `/api/projects/${projectId}/issues?limit=1&offset=${offset}&sort=${sort}`,
    ),
  );
  return (body.items as Doc[]).map((i) => String(i.displayId).replace(/^.*-/, 'ISS-'));
};

describe('the issue list read one row at a time', () => {
  it('walks six issues sharing one created_at in key order, at every offset', async () => {
    const walked: string[] = [];
    for (let offset = 0; offset < 6; offset++)
      walked.push(...(await pageOf('createdAt:asc', offset)));
    expect(walked).toEqual(['ISS-1', 'ISS-2', 'ISS-3', 'ISS-4', 'ISS-5', 'ISS-6']);
  });

  it.each(SORTS)('answers every issue exactly once under %s', async (sort) => {
    const walked: string[] = [];
    for (let offset = 0; offset < 6; offset++) walked.push(...(await pageOf(sort, offset)));
    expect(walked).toEqual(['ISS-1', 'ISS-2', 'ISS-3', 'ISS-4', 'ISS-5', 'ISS-6']);
  });
});
