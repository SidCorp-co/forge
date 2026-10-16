/**
 * ISS-1229 r10 — judge-22 archived its scratch project with live issues and their notices kept
 * coming. The waiting-park and owed-close sweeps raise nothing for an issue of an archived project,
 * and resolve what they raised there before it was archived. (The orphan sweep is held to the same
 * in `issue-run-invariant-e2e`, the idle sweep in `idle-issues-archived-e2e`.)
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Detect = (now?: Date) => Promise<{ detected: number; notified: number }>;

let harness: TestDatabase;
let detectStrandedIssues: Detect;
let detectOwedCloses: Detect;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  const mod = await import('../../src/pipeline/stranded-issues.js');
  detectStrandedIssues = mod.detectStrandedIssues;
  detectOwedCloses = mod.detectOwedCloses;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const { resetSweepCursorsForTest } = await import('../../src/pipeline/sweep-cursor.js');
  resetSweepCursorsForTest();
});

const DAYS_AGO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

/** An issue at `status` merged and last written two days ago, on a project with an admin. */
async function seed(status: string): Promise<{ issueId: string; projectId: string }> {
  const owner = await createTestUser(harness.db);
  const org = await seedOrg(harness.db, owner.id);
  const project = await createTestProject(harness.db, owner.id, { orgId: org.id });
  const admin = await createTestUser(harness.db);
  await createTestProjectMember(harness.db, {
    userId: admin.id,
    projectId: project.id,
    role: 'admin',
  });
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, merged_at, iss_seq)
    VALUES (${issueId}, ${project.id}, 'archived probe', ${status}, ${owner.id}, ${DAYS_AGO}, 1)
  `);
  await harness.db.execute(sql`UPDATE issues SET updated_at = ${DAYS_AGO} WHERE id = ${issueId}`);
  return { issueId, projectId: project.id };
}

/** A first sighting writes a pending record; aged past its pending window, the next one tells. */
async function announce(detect: Detect): Promise<void> {
  await detect();
  await harness.db.execute(
    sql`UPDATE notifications SET pending_since = now() - interval '10 minutes'`,
  );
  await detect();
}

const archive = (projectId: string) =>
  harness.db.execute(sql`UPDATE projects SET archived_at = now() WHERE id = ${projectId}`);

async function openNotices(issueId: string): Promise<number> {
  const rows = (await harness.db.execute(
    sql`SELECT 1 FROM notifications WHERE issue_id = ${issueId} AND resolved_at IS NULL`,
  )) as unknown as unknown[];
  return rows.length;
}

describe.each([
  ['waiting-park', 'waiting', () => detectStrandedIssues],
  ['owed-close', 'developed', () => detectOwedCloses],
] as const)('the %s sweep on an archived project', (_name, status, sweep) => {
  it('raises no notice for its issue', async () => {
    const s = await seed(status);
    await archive(s.projectId);

    await expect(sweep()()).resolves.toMatchObject({ detected: 0 });
    expect(await openNotices(s.issueId)).toBe(0);
  });

  it('resolves the notice it raised before the archive', async () => {
    const s = await seed(status);
    await announce(sweep());
    expect(await openNotices(s.issueId)).toBe(1);

    await archive(s.projectId);
    await sweep()();

    expect(await openNotices(s.issueId)).toBe(0);
  });
});
