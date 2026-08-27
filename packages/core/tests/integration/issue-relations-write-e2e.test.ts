import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type ReadModule = typeof import('../../src/issues/dependency-read.js');
type WriteModule = typeof import('../../src/mcp/tools/issue-relations.js');

describe('ISS-868 issue relations writer', () => {
  let harness: TestDatabase;
  let loadIssueRelations: ReadModule['loadIssueRelations'];
  let applyIssueRelations: WriteModule['applyIssueRelations'];
  let projectId: string;
  let ownerId: string;

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
    ({ loadIssueRelations } = await import('../../src/issues/dependency-read.js'));
    ({ applyIssueRelations } = await import('../../src/mcp/tools/issue-relations.js'));
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    ownerId = user.id;
    projectId = project.id;
  });

  async function insertIssue(seq: number, status = 'open'): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`Issue ${seq}`}, ${status}, ${ownerId})
    `);
    return id;
  }

  it('persists update-style direction mapping and retraction for a PAT principal', async () => {
    const blocker = await insertIssue(91, 'developed');
    const dependent = await insertIssue(92);
    const tokenId = randomUUID();
    const device = {
      id: tokenId,
      ownerId,
      name: 'synthetic-pat-device',
      platform: 'linux' as const,
      agentVersion: null,
      tokenHash: 'test-token-hash',
      tokenPrefix: 'test0001',
      disabledAt: null,
      status: 'online' as const,
      lastSeenAt: null,
      pairedAt: new Date(),
      capabilities: null,
      machineId: null,
      gitCredentialRef: null,
      createdAt: new Date(),
    };
    const ctx = {
      device,
      principal: {
        kind: 'pat' as const,
        agency: 'human' as const,
        userId: ownerId,
        tokenId,
        scopes: ['read', 'write'],
        projectIds: null,
        boundProjectId: null,
      },
      projectSlug: null,
    } as Parameters<WriteModule['applyIssueRelations']>[0];

    const [created] = await applyIssueRelations(ctx, projectId, dependent, [
      { kind: 'blocks', dependsOnId: blocker },
    ]);
    expect(created).toMatchObject({
      kind: 'blocks',
      fromIssueId: blocker,
      toIssueId: dependent,
      created: true,
      updated: false,
    });

    const [live] = (await loadIssueRelations(dependent)).blockedBy;
    expect(live).toMatchObject({ fromIssueId: blocker, toIssueId: dependent, gatesDispatch: true });

    const [retracted] = await applyIssueRelations(ctx, projectId, dependent, [
      { kind: 'blocks', dependsOnId: blocker, validUntil: '2020-01-01T00:00:00.000Z' },
    ]);
    expect(retracted).toMatchObject({ edgeId: created?.edgeId, created: false, updated: true });

    const [expired] = (await loadIssueRelations(dependent)).blockedBy;
    expect(expired).toMatchObject({ expired: true, gatesDispatch: false });

    const activityRows = await harness.db.execute<{
      actor_type: string;
      actor_id: string;
    }>(sql`
      SELECT actor_type, actor_id
      FROM activity_log
      WHERE issue_id = ${dependent}
        AND action = 'issue.dependency.added'
    `);
    expect(activityRows).toContainEqual({ actor_type: 'user', actor_id: ownerId });
  });
});
