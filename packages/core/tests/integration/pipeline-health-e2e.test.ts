/**
 * ISS-164 — pipelineHealth loader integration tests against real Postgres.
 *
 * The unit-mock approach (mocking `db.execute`) tested in
 * `agent-sessions-hydrator.test.ts` works for pure helpers but the classifier
 * here threads six SQL queries through drizzle and asserts the join behaviour
 * itself. Hitting the real schema + migrations is the only way to keep the
 * predicates honest against future column drift (e.g. ISS-162 D1 dropping
 * `jobs.gate_reason`).
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
  hydratePipelineHealthForIssues: typeof import('../../src/issues/pipeline-health.js').hydratePipelineHealthForIssues;
  recordTickAt: typeof import('../../src/issues/pipeline-health.js').recordTickAt;
  resetLastTickAtForTest: typeof import('../../src/issues/pipeline-health.js').resetLastTickAtForTest;
};

describe('ISS-164 pipelineHealth E2E', () => {
  let harness: TestDatabase;
  let mods: Mods;

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

    mods = (await import('../../src/issues/pipeline-health.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    mods.resetLastTickAtForTest();
  });

  async function seedProject(opts?: { maxConcurrentIssues?: number }) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    if (opts?.maxConcurrentIssues !== undefined) {
      const cap = opts.maxConcurrentIssues;
      await harness.db.execute(sql`
        UPDATE projects
        SET agent_config = COALESCE(agent_config, '{}'::jsonb)
                         || jsonb_build_object(
                              'pipelineConfig',
                              COALESCE(agent_config -> 'pipelineConfig', '{}'::jsonb)
                                || jsonb_build_object('maxConcurrentIssues', ${cap}::int))
        WHERE id = ${project.id}
      `);
    }
    return { owner, project };
  }

  async function insertIssue(
    projectId: string,
    overrides: { status?: string; issSeq?: number; manualHold?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = overrides.status ?? 'open';
    const issSeq = overrides.issSeq ?? Math.floor(Math.random() * 100000);
    const manualHold = overrides.manualHold ?? false;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, manual_hold, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${issSeq}, ${'Issue ' + issSeq}, ${status}, 'medium', ${manualHold},
        (SELECT owner_id FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  async function insertSession(
    projectId: string,
    args: { issueId?: string | null; status?: string; skill?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = args.status ?? 'queued';
    const metaObj: Record<string, unknown> = {};
    if (args.issueId) metaObj.issueId = args.issueId;
    if (args.skill) metaObj.skill = args.skill;
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, status, metadata)
      VALUES (${id}, ${projectId}, ${status}, ${JSON.stringify(metaObj)}::jsonb)
    `);
    return id;
  }

  async function insertJob(
    projectId: string,
    args: {
      issueId?: string | null;
      status?: string;
      type?: string;
      queuedAt?: Date;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = args.status ?? 'queued';
    const type = args.type ?? 'plan';
    const queuedAt = args.queuedAt ?? new Date();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, payload, queued_at, created_by)
      VALUES (
        ${id}, ${projectId}, ${args.issueId ?? null}, ${type}, ${status},
        '{}'::jsonb, ${queuedAt.toISOString()},
        (SELECT owner_id FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  async function insertEdge(
    projectId: string,
    fromIssueId: string,
    toIssueId: string,
    kind: 'blocks' | 'decomposes',
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
      VALUES (${id}, ${projectId}, ${fromIssueId}, ${toIssueId}, ${kind})
    `);
    return id;
  }

  it('returns empty map when issueIds is empty', async () => {
    const { project } = await seedProject();
    const map = await mods.hydratePipelineHealthForIssues(project.id, []);
    expect(map.size).toBe(0);
  });

  it('returns `{ stage }` only when no queued jobs exist', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, { status: 'approved' });
    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    const health = map.get(issueId);
    expect(health).toBeDefined();
    expect(health?.stage).toBe('approved');
    expect(health?.waitingOn).toBeUndefined();
    expect(health?.queuedAt).toBeUndefined();
  });

  it('exposes activeSession when a running session is linked', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id);
    const sessionId = await insertSession(project.id, {
      issueId,
      status: 'running',
      skill: 'forge-code',
    });
    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    const health = map.get(issueId);
    expect(health?.activeSession).toEqual({
      id: sessionId,
      status: 'running',
      skill: 'forge-code',
    });
  });

  it('classifies manual_hold when issue.manualHold is true', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id, { manualHold: true });
    await insertJob(project.id, { issueId, status: 'queued', type: 'plan' });
    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    expect(map.get(issueId)?.waitingOn?.reason).toBe('manual_hold');
  });

  it('classifies project_full IMMEDIATELY at queue time (ISS-137 blind-spot closure)', async () => {
    const { project } = await seedProject({ maxConcurrentIssues: 1 });
    const issueA = await insertIssue(project.id);
    const issueB = await insertIssue(project.id);

    // Issue A holds the only concurrency slot via a running session.
    const sessionA = await insertSession(project.id, {
      issueId: issueA,
      status: 'running',
    });
    // Issue B has a fresh queued job, no agent_session yet.
    await insertJob(project.id, { issueId: issueB, status: 'queued', type: 'plan' });

    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueA, issueB]);

    expect(map.get(issueA)?.activeSession?.id).toBe(sessionA);
    expect(map.get(issueA)?.waitingOn).toBeUndefined();

    const bHealth = map.get(issueB);
    expect(bHealth?.waitingOn?.reason).toBe('project_full');
    expect(bHealth?.waitingOn?.details.cap).toBe(1);
    expect(bHealth?.waitingOn?.details.running).toContain(issueA);
  });

  it('classifies waiting_on_dep when a blocks parent is non-terminal', async () => {
    const { project } = await seedProject();
    const blocker = await insertIssue(project.id, { status: 'open' });
    const child = await insertIssue(project.id);
    await insertEdge(project.id, blocker, child, 'blocks');
    await insertJob(project.id, { issueId: child, status: 'queued', type: 'plan' });

    const map = await mods.hydratePipelineHealthForIssues(project.id, [child]);
    const health = map.get(child);
    expect(health?.waitingOn?.reason).toBe('waiting_on_dep');
    expect(health?.waitingOn?.details.blockerIssueIds).toEqual([blocker]);
  });

  it('classifies waiting_on_decomp_parent for release jobs only', async () => {
    const { project } = await seedProject();
    const parent = await insertIssue(project.id, { status: 'approved' });
    const child = await insertIssue(project.id);
    await insertEdge(project.id, parent, child, 'decomposes');
    await insertJob(project.id, { issueId: child, status: 'queued', type: 'release' });

    const map = await mods.hydratePipelineHealthForIssues(project.id, [child]);
    expect(map.get(child)?.waitingOn?.reason).toBe('waiting_on_decomp_parent');
  });

  it('manual_hold wins over a blocks parent (L1 before L2)', async () => {
    const { project } = await seedProject();
    const blocker = await insertIssue(project.id, { status: 'open' });
    const child = await insertIssue(project.id, { manualHold: true });
    await insertEdge(project.id, blocker, child, 'blocks');
    await insertJob(project.id, { issueId: child, status: 'queued', type: 'plan' });
    const map = await mods.hydratePipelineHealthForIssues(project.id, [child]);
    expect(map.get(child)?.waitingOn?.reason).toBe('manual_hold');
  });

  it('classifies issue_busy when a sibling job is dispatched', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id);
    const dispatched = await insertJob(project.id, {
      issueId,
      status: 'dispatched',
      type: 'plan',
    });
    await insertJob(project.id, {
      issueId,
      status: 'queued',
      type: 'review',
      queuedAt: new Date(Date.now() + 1000),
    });
    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    const health = map.get(issueId);
    expect(health?.waitingOn?.reason).toBe('issue_busy');
    expect(health?.waitingOn?.details.blockingJobId).toBe(dispatched);
  });

  it('reports queuedAt + lastTickAt when queued + unblocked', async () => {
    const { project } = await seedProject({ maxConcurrentIssues: 5 });
    const issueId = await insertIssue(project.id);
    const queuedAt = new Date(Date.now() - 60_000);
    await insertJob(project.id, { issueId, status: 'queued', type: 'plan', queuedAt });
    const tickAt = new Date();
    mods.recordTickAt(project.id, tickAt);

    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    const health = map.get(issueId);
    expect(health?.waitingOn).toBeUndefined();
    expect(health?.queuedAt).toBe(queuedAt.toISOString());
    expect(health?.lastTickAt).toBe(tickAt.toISOString());
  });

  it('never reads jobs.gate_reason (live-join contract — preserved after D1 column drop)', async () => {
    // Spy on db.execute to capture SQL strings. This codifies the contract
    // that the loader classifies from the live join, not the persisted column.
    const dbModule = (await import('../../src/db/client.js')) as {
      db: { execute: (...args: unknown[]) => unknown };
    };
    const capturedSql: string[] = [];
    const original = dbModule.db.execute.bind(dbModule.db);
    const spy = function patched(this: unknown, ...args: unknown[]) {
      const node = args[0] as { queryChunks?: Array<{ value?: unknown }> } | undefined;
      try {
        const flat = JSON.stringify(node?.queryChunks ?? node ?? '');
        capturedSql.push(flat);
      } catch {
        /* ignore */
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    (dbModule.db.execute as unknown) = spy;
    try {
      const { project } = await seedProject();
      const issueId = await insertIssue(project.id);
      await insertJob(project.id, { issueId, status: 'queued', type: 'plan' });
      await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
      for (const s of capturedSql) {
        expect(s).not.toContain('gate_reason');
      }
    } finally {
      (dbModule.db.execute as unknown) = original;
    }
  });
});
