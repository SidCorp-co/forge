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
type WriteModule = typeof import('../../src/issues/relations-service.js');

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
    ({ applyIssueRelations } = await import('../../src/issues/relations-service.js'));
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

  // cm:guard a PAT reaches the write behind a SYNTHETIC device whose id is an api_tokens row, so the writer's actor MUST be the user — a device-shaped actor writes an activity_log actor_id matching no `devices` row
  function makePatWriter(): Parameters<WriteModule['applyIssueRelations']>[0] {
    return { actor: { type: 'user', id: ownerId }, createdById: ownerId };
  }

  it('persists update-style direction mapping and retraction for a PAT principal', async () => {
    const blocker = await insertIssue(91, 'developed');
    const dependent = await insertIssue(92);
    const writer = makePatWriter();

    const [created] = await applyIssueRelations(writer, projectId, dependent, [
      { kind: 'blocks', dependsOnId: blocker },
    ]);
    expect(created).toMatchObject({
      kind: 'blocks',
      fromIssueId: blocker,
      toIssueId: dependent,
      created: true,
      updated: false,
    });

    const [live] = (await loadIssueRelations(dependent, projectId)).blockedBy;
    expect(live).toMatchObject({ fromIssueId: blocker, toIssueId: dependent, gatesDispatch: true });

    const [retracted] = await applyIssueRelations(writer, projectId, dependent, [
      { kind: 'blocks', dependsOnId: blocker, validUntil: '2020-01-01T00:00:00.000Z' },
    ]);
    expect(retracted).toMatchObject({ edgeId: created?.edgeId, created: false, updated: true });

    const [expired] = (await loadIssueRelations(dependent, projectId)).blockedBy;
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

  it('commits every edge of a multi-entry relations array, both directions, in one call', async () => {
    const blockerA = await insertIssue(93, 'developed');
    const blockerB = await insertIssue(94);
    const dependent = await insertIssue(95);
    const downstream = await insertIssue(96);
    const writer = makePatWriter();

    const applied = await applyIssueRelations(writer, projectId, dependent, [
      { kind: 'blocks', dependsOnId: blockerA },
      { kind: 'blocks', dependsOnId: blockerB },
      { kind: 'blocks', blocksId: downstream },
      { kind: 'relates', dependsOnId: blockerA },
    ]);
    expect(applied.every((e) => e.created)).toBe(true);

    const rows = await harness.db.execute<{ from_issue_id: string; to_issue_id: string }>(sql`
      SELECT from_issue_id, to_issue_id FROM issue_dependencies
      WHERE project_id = ${projectId} AND kind = 'blocks'
      ORDER BY from_issue_id
    `);
    expect(rows).toHaveLength(3);

    const { blocks, blockedBy } = await loadIssueRelations(dependent, projectId);
    expect(
      blockedBy
        .filter((e) => e.kind === 'blocks')
        .map((e) => e.fromIssueId)
        .sort(),
    ).toEqual([blockerA, blockerB].sort());
    expect(blocks.map((e) => e.toIssueId)).toEqual([downstream]);
    expect(blockedBy.find((e) => e.fromIssueId === blockerA)?.gatesDispatch).toBe(true);
    expect(blockedBy.find((e) => e.fromIssueId === blockerB)?.gatesDispatch).toBe(true);
  });
});
