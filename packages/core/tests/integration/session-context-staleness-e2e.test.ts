/**
 * ISS-699 — `countStepsSince` DB-query coverage.
 *
 * `src/prompt/user.test.ts` covers the render layer (banner text/position)
 * by injecting a pre-built `supersededBy` object; nothing exercises the
 * `jobs` SELECT inside `countStepsSince` itself. This drives the exported
 * `loadIssueSnapshot` (which calls it transitively) against real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  loadIssueSnapshot: typeof import('../../src/prompt/issue-snapshot.js').loadIssueSnapshot;
};

describe('ISS-699 countStepsSince staleness query', () => {
  let harness: TestDatabase;
  let mods: Mods;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';

    const mod = await import('../../src/prompt/issue-snapshot.js');
    mods = { loadIssueSnapshot: mod.loadIssueSnapshot };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function insertIssue(
    projectId: string,
    ownerId: string,
    sessionContext: unknown = null,
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id, session_context)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', 'open', 'medium', ${ownerId}, ${sessionContext ? JSON.stringify(sessionContext) : null}::jsonb
      )
    `);
    return id;
  }

  async function insertPipelineRun(projectId: string, issueId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, ${issueId}, 'issue', 'completed', now())
    `);
    return id;
  }

  async function insertJob(args: {
    projectId: string;
    issueId: string;
    ownerId: string;
    type: string;
    status: string;
    finishedAt: string | null;
  }): Promise<string> {
    const id = randomUUID();
    const pipelineRunId = await insertPipelineRun(args.projectId, args.issueId);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, pipeline_run_id, created_by, finished_at)
      VALUES (
        ${id}, ${args.projectId}, ${args.issueId}, ${args.type}, ${args.status},
        ${pipelineRunId}, ${args.ownerId}, ${args.finishedAt}
      )
    `);
    return id;
  }

  async function seed() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    return { owner, project };
  }

  it('counts only terminal jobs finished after lastUpdated, reporting the newest first', async () => {
    const { owner, project } = await seed();
    const lastUpdated = '2026-08-11T04:44:00.000Z';
    const issueId = await insertIssue(project.id, owner.id, { lastUpdated });

    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'fix',
      status: 'done',
      finishedAt: '2026-08-11T04:50:00.000Z',
    });
    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'review',
      status: 'done',
      finishedAt: '2026-08-11T04:55:00.000Z',
    });
    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'test',
      status: 'done',
      finishedAt: '2026-08-11T05:01:56.000Z',
    });

    const snapshot = await mods.loadIssueSnapshot(issueId);
    expect(snapshot?.supersededBy).toEqual({
      count: 3,
      latestType: 'test',
      latestFinishedAt: '2026-08-11T05:01:56.000Z',
    });
  });

  it('counts both done and failed jobs but excludes queued/running', async () => {
    const { owner, project } = await seed();
    const lastUpdated = '2026-08-11T04:44:00.000Z';
    const issueId = await insertIssue(project.id, owner.id, { lastUpdated });

    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'code',
      status: 'failed',
      finishedAt: '2026-08-11T04:50:00.000Z',
    });
    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'review',
      status: 'queued',
      finishedAt: null,
    });
    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'test',
      status: 'running',
      finishedAt: null,
    });

    const snapshot = await mods.loadIssueSnapshot(issueId);
    expect(snapshot?.supersededBy).toEqual({
      count: 1,
      latestType: 'code',
      latestFinishedAt: '2026-08-11T04:50:00.000Z',
    });
  });

  it('returns null supersededBy when no job finished after lastUpdated', async () => {
    const { owner, project } = await seed();
    const lastUpdated = '2026-08-11T04:44:00.000Z';
    const issueId = await insertIssue(project.id, owner.id, { lastUpdated });

    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'triage',
      status: 'done',
      finishedAt: '2026-08-11T04:30:00.000Z',
    });

    const snapshot = await mods.loadIssueSnapshot(issueId);
    expect(snapshot?.supersededBy).toBeNull();
  });

  it('returns null supersededBy when sessionContext has no lastUpdated', async () => {
    const { owner, project } = await seed();
    const issueId = await insertIssue(project.id, owner.id, { currentState: 'no timestamp' });

    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'test',
      status: 'done',
      finishedAt: '2026-08-11T05:01:56.000Z',
    });

    const snapshot = await mods.loadIssueSnapshot(issueId);
    expect(snapshot?.supersededBy).toBeNull();
  });

  it('returns null supersededBy when sessionContext is missing entirely', async () => {
    const { owner, project } = await seed();
    const issueId = await insertIssue(project.id, owner.id, null);

    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'test',
      status: 'done',
      finishedAt: '2026-08-11T05:01:56.000Z',
    });

    const snapshot = await mods.loadIssueSnapshot(issueId);
    expect(snapshot?.supersededBy).toBeNull();
  });

  it('returns null supersededBy when lastUpdated is an invalid date string', async () => {
    const { owner, project } = await seed();
    const issueId = await insertIssue(project.id, owner.id, { lastUpdated: 'not-a-date' });

    await insertJob({
      projectId: project.id,
      issueId,
      ownerId: owner.id,
      type: 'test',
      status: 'done',
      finishedAt: '2026-08-11T05:01:56.000Z',
    });

    const snapshot = await mods.loadIssueSnapshot(issueId);
    expect(snapshot?.supersededBy).toBeNull();
  });

  it("does not leak another issue's newer job into this issue's count", async () => {
    const { owner, project } = await seed();
    const lastUpdated = '2026-08-11T04:44:00.000Z';
    const issueId = await insertIssue(project.id, owner.id, { lastUpdated });
    const otherIssueId = await insertIssue(project.id, owner.id, { lastUpdated });

    await insertJob({
      projectId: project.id,
      issueId: otherIssueId,
      ownerId: owner.id,
      type: 'test',
      status: 'done',
      finishedAt: '2026-08-11T05:01:56.000Z',
    });

    const snapshot = await mods.loadIssueSnapshot(issueId);
    expect(snapshot?.supersededBy).toBeNull();

    const otherSnapshot = await mods.loadIssueSnapshot(otherIssueId);
    expect(otherSnapshot?.supersededBy).toEqual({
      count: 1,
      latestType: 'test',
      latestFinishedAt: '2026-08-11T05:01:56.000Z',
    });
  });
});
