import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
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
type IssuesToolModule = typeof import('../../src/mcp/tools/forge-issues.js');

let harness: TestDatabase;
let loadIssueRelations: ReadModule['loadIssueRelations'];
let applyIssueRelations: WriteModule['applyIssueRelations'];
let finalizeIssueRelations: WriteModule['finalizeIssueRelations'];
let forgeIssuesTool: IssuesToolModule['forgeIssuesTool'];
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
  ({ applyIssueRelations, finalizeIssueRelations } = await import(
    '../../src/mcp/tools/issue-relations.js'
  ));
  ({ forgeIssuesTool } = await import('../../src/mcp/tools/forge-issues.js'));
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

async function insertIssue(
  project: string,
  owner: string,
  seq: number,
  status = 'open',
): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${project}, ${seq}, ${`Issue ${seq}`}, ${status}, ${owner})
  `);
  return id;
}

async function installCycleInsertBarrier(): Promise<void> {
  await harness.db.execute(sql`
    CREATE FUNCTION issue_relation_cycle_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('issue-relation-cycle-insert-barrier'));
      PERFORM pg_sleep(0.5);
      RETURN NEW;
    END;
    $$
  `);
  await harness.db.execute(sql`
    CREATE TRIGGER issue_relation_cycle_insert_barrier
    BEFORE INSERT ON issue_dependencies
    FOR EACH ROW EXECUTE FUNCTION issue_relation_cycle_insert_barrier()
  `);
}

async function removeCycleInsertBarrier(): Promise<void> {
  await harness.db.execute(
    sql`DROP TRIGGER issue_relation_cycle_insert_barrier ON issue_dependencies`,
  );
  await harness.db.execute(sql`DROP FUNCTION issue_relation_cycle_insert_barrier()`);
}

async function registerPlanStageSkill(): Promise<void> {
  const skillId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO skills (id, name, description, scope, prompt, source, content_hash)
    VALUES (${skillId}, 'forge-plan', 'integration: forge-plan', 'global', 'noop', 'builtin', ${`hash-${skillId}`})
  `);
  await harness.db.execute(sql`
    INSERT INTO skill_registrations (project_id, skill_id, stage, registered_by)
    VALUES (${projectId}, ${skillId}, 'clarified', ${ownerId})
  `);
}

function makeContext() {
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
  return {
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
}

async function writeRelations(
  ctx: Parameters<WriteModule['applyIssueRelations']>[0],
  issueId: string,
  relations: Parameters<WriteModule['applyIssueRelations']>[3],
) {
  const pending = await harness.db.transaction((tx) =>
    applyIssueRelations(ctx, projectId, issueId, relations, tx),
  );
  await finalizeIssueRelations(ctx, pending);
  return pending;
}

it('persists update-style direction mapping and retraction for a PAT principal', async () => {
  const blocker = await insertIssue(projectId, ownerId, 91, 'developed');
  const dependent = await insertIssue(projectId, ownerId, 92);
  const ctx = makeContext();

  const created = await writeRelations(ctx, dependent, [
    { kind: 'blocks', dependsOnId: blocker, validUntil: '2099-01-01T00:00:00.000Z' },
  ]);
  expect(created.relations[0]).toMatchObject({
    kind: 'blocks',
    fromIssueId: blocker,
    toIssueId: dependent,
    created: true,
    updated: false,
  });

  const [live] = (await loadIssueRelations(dependent)).blockedBy;
  expect(live).toMatchObject({ fromIssueId: blocker, toIssueId: dependent, gatesDispatch: true });

  await harness.db.execute(sql`UPDATE issues SET status = 'dropped' WHERE id = ${blocker}`);
  const retracted = await writeRelations(ctx, dependent, [
    { kind: 'blocks', dependsOnId: blocker, validUntil: '2020-01-01T00:00:00.000Z' },
  ]);
  expect(retracted.relations[0]).toMatchObject({
    edgeId: created.relations[0]?.edgeId,
    created: false,
    updated: true,
  });

  const [expired] = (await loadIssueRelations(dependent)).blockedBy;
  expect(expired).toMatchObject({ expired: true, gatesDispatch: false });

  const activityRows = await harness.db.execute<{
    actor_type: string;
    actor_id: string;
    payload: { validUntil?: string };
  }>(sql`
    SELECT actor_type, actor_id, payload
    FROM activity_log
    WHERE issue_id = ${dependent}
      AND action = 'issue.dependency.added'
  `);
  expect(activityRows).toContainEqual({
    actor_type: 'user',
    actor_id: ownerId,
    payload: expect.objectContaining({ validUntil: '2099-01-01T00:00:00.000Z' }),
  });
});

it('rolls back every relation when a later relation is invalid', async () => {
  const blocker = await insertIssue(projectId, ownerId, 93);
  const dependent = await insertIssue(projectId, ownerId, 94);
  const outsider = await createTestUser(harness.db);
  const otherProject = await createTestProject(harness.db, outsider.id);
  const foreignIssue = await insertIssue(otherProject.id, outsider.id, 95);
  const ctx = makeContext();

  await expect(
    harness.db.transaction((tx) =>
      applyIssueRelations(
        ctx,
        projectId,
        dependent,
        [
          { kind: 'blocks', dependsOnId: blocker },
          { kind: 'blocks', dependsOnId: foreignIssue },
        ],
        tx,
      ),
    ),
  ).rejects.toThrow(/projectId/);

  const edges = await harness.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count
    FROM issue_dependencies
    WHERE from_issue_id = ${blocker} AND to_issue_id = ${dependent}
  `);
  expect(edges).toEqual([{ count: '0' }]);
});

it('rejects a blocks relation whose source issue is dropped', async () => {
  const dropped = await insertIssue(projectId, ownerId, 95, 'dropped');
  const dependent = await insertIssue(projectId, ownerId, 96);

  await expect(
    writeRelations(makeContext(), dependent, [{ kind: 'blocks', dependsOnId: dropped }]),
  ).rejects.toThrow(/dropped issue/);
});

it('serializes concurrent opposite blocks edges', async () => {
  const first = await insertIssue(projectId, ownerId, 95);
  const second = await insertIssue(projectId, ownerId, 96);
  await installCycleInsertBarrier();

  const results = await Promise.allSettled([
    writeRelations(makeContext(), second, [{ kind: 'blocks', dependsOnId: first }]),
    writeRelations(makeContext(), first, [{ kind: 'blocks', dependsOnId: second }]),
  ]);

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const [edge] = await harness.db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM issue_dependencies
    WHERE kind = 'blocks' AND project_id = ${projectId}
  `);
  expect(edge).toEqual({ count: '1' });
  await removeCycleInsertBarrier();
});

it('keeps an expired edge inactive when an MCP caller updates only its reason', async () => {
  const first = await insertIssue(projectId, ownerId, 95);
  const second = await insertIssue(projectId, ownerId, 96);
  const ctx = makeContext();

  await writeRelations(ctx, second, [
    { kind: 'blocks', dependsOnId: first, validUntil: '2020-01-01T00:00:00.000Z' },
  ]);
  await writeRelations(ctx, first, [{ kind: 'blocks', dependsOnId: second }]);

  const update = await writeRelations(ctx, second, [
    { kind: 'blocks', dependsOnId: first, reason: 'historical relation' },
  ]);

  expect(update.relations[0]).toMatchObject({ created: false, updated: true });
  const [expired] = (await loadIssueRelations(second)).blockedBy;
  expect(expired).toMatchObject({ expired: true, gatesDispatch: false });
});

it('allows a plan patch and approved transition with a relation in one transaction', async () => {
  await registerPlanStageSkill();
  const blocker = await insertIssue(projectId, ownerId, 96);
  const dependent = await insertIssue(projectId, ownerId, 97, 'clarified');
  const ctx = makeContext();

  const result = (await forgeIssuesTool(ctx).handler({
    action: 'update',
    documentId: dependent,
    data: {
      plan: 'Ship the relation writer',
      status: 'approved',
      relations: [{ kind: 'blocks', dependsOnId: blocker }],
    },
  })) as { status: string; relations: Array<{ fromIssueId: string; toIssueId: string }> };

  expect(result.status).toBe('approved');
  expect(result.relations).toEqual([
    expect.objectContaining({ fromIssueId: blocker, toIssueId: dependent }),
  ]);
});

it('rolls back fields, status, and relations when a later relation is invalid', async () => {
  const blocker = await insertIssue(projectId, ownerId, 96);
  const dependent = await insertIssue(projectId, ownerId, 97);
  const outsider = await createTestUser(harness.db);
  const otherProject = await createTestProject(harness.db, outsider.id);
  const foreignIssue = await insertIssue(otherProject.id, outsider.id, 98);
  const ctx = makeContext();

  await expect(
    forgeIssuesTool(ctx).handler({
      action: 'update',
      documentId: dependent,
      data: {
        plan: 'must roll back',
        status: 'confirmed',
        relations: [
          { kind: 'blocks', dependsOnId: blocker },
          { kind: 'blocks', dependsOnId: foreignIssue },
        ],
      },
    }),
  ).rejects.toThrow(/projectId/);

  const [issue] = await harness.db.execute<{ plan: string | null; status: string }>(sql`
    SELECT plan, status FROM issues WHERE id = ${dependent}
  `);
  expect(issue).toEqual({ plan: null, status: 'open' });
  expect((await loadIssueRelations(dependent)).blockedBy).toEqual([]);
});

it('rolls back fields and relations when a concurrent status update wins', async () => {
  const blocker = await insertIssue(projectId, ownerId, 99);
  const dependent = await insertIssue(projectId, ownerId, 100);
  const ctx = makeContext();

  await harness.db.execute(sql`
    CREATE FUNCTION force_relation_update_stale() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.plan = 'trigger stale relation update' AND OLD.plan IS DISTINCT FROM NEW.plan THEN
        UPDATE issues SET status = 'confirmed' WHERE id = NEW.id;
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await harness.db.execute(sql`
    CREATE TRIGGER force_relation_update_stale
    AFTER UPDATE OF plan ON issues
    FOR EACH ROW EXECUTE FUNCTION force_relation_update_stale()
  `);

  try {
    await expect(
      forgeIssuesTool(ctx).handler({
        action: 'update',
        documentId: dependent,
        data: {
          plan: 'trigger stale relation update',
          status: 'confirmed',
          relations: [{ kind: 'blocks', dependsOnId: blocker }],
        },
      }),
    ).rejects.toThrow(/STALE_TRANSITION/);
  } finally {
    await harness.db.execute(sql`DROP TRIGGER IF EXISTS force_relation_update_stale ON issues`);
    await harness.db.execute(sql`DROP FUNCTION IF EXISTS force_relation_update_stale()`);
  }

  const [issue] = await harness.db.execute<{ plan: string | null; status: string }>(sql`
    SELECT plan, status FROM issues WHERE id = ${dependent}
  `);
  expect(issue).toEqual({ plan: null, status: 'open' });
  expect((await loadIssueRelations(dependent)).blockedBy).toEqual([]);
});

it('rolls back an attempted expiry when a later relation is invalid', async () => {
  const blocker = await insertIssue(projectId, ownerId, 96);
  const dependent = await insertIssue(projectId, ownerId, 97);
  const outsider = await createTestUser(harness.db);
  const otherProject = await createTestProject(harness.db, outsider.id);
  const foreignIssue = await insertIssue(otherProject.id, outsider.id, 98);
  const ctx = makeContext();

  await writeRelations(ctx, dependent, [{ kind: 'blocks', dependsOnId: blocker }]);

  await expect(
    harness.db.transaction((tx) =>
      applyIssueRelations(
        ctx,
        projectId,
        dependent,
        [
          { kind: 'blocks', dependsOnId: blocker, validUntil: '2020-01-01T00:00:00.000Z' },
          { kind: 'blocks', dependsOnId: foreignIssue },
        ],
        tx,
      ),
    ),
  ).rejects.toThrow(/projectId/);

  const [live] = (await loadIssueRelations(dependent)).blockedBy;
  expect(live).toMatchObject({ fromIssueId: blocker, expired: false, gatesDispatch: true });
});
