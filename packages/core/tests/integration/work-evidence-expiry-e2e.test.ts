import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

it('requires work evidence after every decomposes edge expires', async () => {
  const owner = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, owner.id);
  const device = await createTestDevice(harness.db, owner.id);
  const parent = await insertIssue(project.id, owner.id, 'approved');
  const child = await insertIssue(project.id, owner.id, 'open');

  await harness.db.execute(sql`
    INSERT INTO issue_dependencies (
      project_id, from_issue_id, to_issue_id, kind, created_by_id, valid_until
    )
    VALUES (${project.id}, ${parent}, ${child}, 'decomposes', ${owner.id}, '2020-01-01T00:00:00.000Z')
  `);

  const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
  await expect(
    transitionIssueStatus(
      { id: parent, projectId: project.id, status: 'approved', reopenCount: 0 },
      'developed',
      { type: 'device', id: device.id, ownerId: owner.id },
    ),
  ).rejects.toMatchObject({ code: 'NO_WORK_EVIDENCE' });
});

async function insertIssue(projectId: string, ownerId: string, status: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, status, created_by_id)
    VALUES (${projectId}, 'work evidence expiry', ${status}, ${ownerId})
    RETURNING id
  `);
  const row = rows[0];
  if (!row) throw new Error('issue insert returned no row');
  return row.id;
}
