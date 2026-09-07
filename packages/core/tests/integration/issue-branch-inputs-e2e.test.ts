/**
 * ISS-936 extra fix — `readIssueBranchInputs` has to return the field its only
 * caller reads FIRST.
 *
 * `extractIssueBranchOverride` prefers `metadata.branchConfig` and falls back to
 * `sessionContext.branchConfig`, and the reader behind `forge_config`'s
 * issue-aware branch resolution selected only `sessionContext` — so an issue
 * carrying a real override resolved to the project default, silently. The unit
 * lane could not see it: it mocks the row, and a mocked row carries `metadata`
 * whatever the SELECT asked for. Only a real query can go red here.
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

describe('readIssueBranchInputs (ISS-936)', () => {
  let harness: TestDatabase;
  let readIssueBranchInputs: typeof import('../../src/projects/service.js')['readIssueBranchInputs'];
  let extractIssueBranchOverride: typeof import('../../src/branches/resolve.js')['extractIssueBranchOverride'];
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    const [serviceMod, resolveMod] = await Promise.all([
      import('../../src/projects/service.js'),
      import('../../src/branches/resolve.js'),
    ]);
    readIssueBranchInputs = serviceMod.readIssueBranchInputs;
    extractIssueBranchOverride = resolveMod.extractIssueBranchOverride;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    userId = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, userId)).id;
  });

  async function insertIssue(fields: {
    metadata?: unknown;
    sessionContext?: unknown;
  }): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, metadata, session_context)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', 'open', ${userId},
        ${fields.metadata === undefined ? null : JSON.stringify(fields.metadata)}::jsonb,
        ${fields.sessionContext === undefined ? null : JSON.stringify(fields.sessionContext)}::jsonb
      )
    `);
    return id;
  }

  it('returns a metadata.branchConfig override, so the caller resolves it', async () => {
    const issueId = await insertIssue({
      metadata: { branchConfig: { baseBranch: 'feat/from-metadata' } },
    });

    const row = await readIssueBranchInputs(issueId, projectId);

    expect(row).not.toBeNull();
    expect(
      extractIssueBranchOverride(row as Parameters<typeof extractIssueBranchOverride>[0]),
    ).toEqual({ baseBranch: 'feat/from-metadata' });
  });

  it('lets metadata win over the older sessionContext location', async () => {
    const issueId = await insertIssue({
      metadata: { branchConfig: { baseBranch: 'feat/from-metadata' } },
      sessionContext: { branchConfig: { baseBranch: 'feat/from-session' } },
    });

    const row = await readIssueBranchInputs(issueId, projectId);

    expect(
      extractIssueBranchOverride(row as Parameters<typeof extractIssueBranchOverride>[0]),
    ).toEqual({ baseBranch: 'feat/from-metadata' });
  });

  it('still returns the sessionContext override when metadata carries none', async () => {
    const issueId = await insertIssue({
      sessionContext: { branchConfig: { baseBranch: 'feat/from-session' } },
    });

    const row = await readIssueBranchInputs(issueId, projectId);

    expect(
      extractIssueBranchOverride(row as Parameters<typeof extractIssueBranchOverride>[0]),
    ).toEqual({ baseBranch: 'feat/from-session' });
  });

  it('answers null for an issue in another project', async () => {
    const issueId = await insertIssue({});
    const other = await createTestProject(harness.db, userId, { slug: 'other-proj' });

    expect(await readIssueBranchInputs(issueId, other.id)).toBeNull();
  });
});
