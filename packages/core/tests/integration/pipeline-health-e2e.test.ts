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
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type PipelineHealthModule = typeof import('../../src/issues/pipeline-health.js');

type Mods = {
  hydratePipelineHealthForIssues: PipelineHealthModule['hydratePipelineHealthForIssues'];
  recordTickAt: PipelineHealthModule['recordTickAt'];
  resetLastTickAtForTest: PipelineHealthModule['resetLastTickAtForTest'];
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
    await insertFreshRunner(project.id);
    return { owner, project };
  }

  // cm:guard every fixture project needs one fresh runner or the classifier answers `runner_stale` for all of them — the gate is right to say so (an empty pool dispatches nothing), which is exactly why the default fixture must model a WORKING project and the empty pool gets its own test
  async function insertFreshRunner(projectId: string): Promise<string> {
    const id = randomUUID();
    // cm:guard `runners.device_id` is NOT NULL since 2026-09-04 — seed a real device instead of the `host='remote'`/no-device shape this fixture used, which now fails the insert rather than producing a row.
    const ownerRows = (await harness.db.execute(
      sql`SELECT created_by AS id FROM projects WHERE id = ${projectId}`,
    )) as unknown as Array<{ id: string }>;
    const device = await createTestDevice(harness.db, ownerRows[0]?.id as string);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
      VALUES (${id}, ${projectId}, 'claude-code', ${device.id}, 'fixture-runner', 'online', now())
    `);
    return id;
  }

  async function insertIssue(
    projectId: string,
    overrides: { status?: string; issSeq?: number } = {},
  ): Promise<string> {
    const id = randomUUID();
    const status = overrides.status ?? 'open';
    const issSeq = overrides.issSeq ?? Math.floor(Math.random() * 100000);
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${issSeq}, ${`Issue ${issSeq}`}, ${status}, 'medium',
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  // cm:guard reuse the issue's existing run, never insert a second — `pipeline_runs_issue_open_uq` is a partial unique index admitting ONE non-terminal run per issue, so a fixture that inserts blindly fails on 23505 rather than on what it was testing
  async function getOrCreateRun(projectId: string, issueId: string | null): Promise<string> {
    if (issueId) {
      const existing = await harness.db.execute<{ id: string }>(sql`
        SELECT id FROM pipeline_runs
        WHERE kind = 'issue' AND issue_id = ${issueId} AND status IN ('running','paused')
        LIMIT 1
      `);
      if (existing[0]?.id) return existing[0].id;
      const id = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
        VALUES (${id}, ${projectId}, ${issueId}, 'issue', 'running')
        ON CONFLICT DO NOTHING
      `);
      const after = await harness.db.execute<{ id: string }>(sql`
        SELECT id FROM pipeline_runs
        WHERE kind = 'issue' AND issue_id = ${issueId} AND status IN ('running','paused')
        LIMIT 1
      `);
      return after[0]!.id;
    }
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${id}, ${projectId}, NULL, 'system', 'running')
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
    const runId = await getOrCreateRun(projectId, args.issueId ?? null);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, metadata)
      VALUES (${id}, ${projectId}, ${runId}, ${status}, ${JSON.stringify(metaObj)}::jsonb)
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
    const runId = await getOrCreateRun(projectId, args.issueId ?? null);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, queued_at, created_by)
      VALUES (
        ${id}, ${projectId}, ${args.issueId ?? null}, ${runId}, ${type}, ${status},
        '{}'::jsonb, ${queuedAt.toISOString()},
        (SELECT created_by FROM projects WHERE id = ${projectId})
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

  // cm:guard an issue with an UNMERGED blocker must report NO waitingOn — this is the behaviour the blocker gate's deletion changed, and it is the whole point: a `blocks` edge is a fact the master reads and weighs (a docs-only dependent can run beside its blocker), not a condition the kernel enforces. A `waiting_on_dep` reappearing here means routing moved back into core.
  it('does not report a blocker as a wait — the edge is a fact, not a gate', async () => {
    const { project } = await seedProject();
    const blocker = await insertIssue(project.id, { status: 'open' });
    const child = await insertIssue(project.id);
    await insertEdge(project.id, blocker, child, 'blocks');
    await insertJob(project.id, { issueId: child, status: 'queued', type: 'plan' });

    const map = await mods.hydratePipelineHealthForIssues(project.id, [child]);
    expect(map.get(child)?.waitingOn).toBeUndefined();
  });

  // cm:guard the same for a blocker that closed WITHOUT its code landing — the one case the old gate treated as permanently blocking. It is still the most alarming shape on the board, and it is still the master's call, so health must not pre-empt it with a verdict.
  it('does not report a closed-but-unmerged blocker as a wait either', async () => {
    const { project } = await seedProject();
    const blocker = await insertIssue(project.id, { status: 'closed' });
    const child = await insertIssue(project.id);
    await insertEdge(project.id, blocker, child, 'blocks');
    await insertJob(project.id, { issueId: child, status: 'queued', type: 'plan' });

    const map = await mods.hydratePipelineHealthForIssues(project.id, [child]);
    expect(map.get(child)?.waitingOn).toBeUndefined();
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

  // cm:guard these two are the end-to-end proof for the blind spots the unit tests cover in isolation — both used to report NO waitingOn, so the board rendered a permanently-stuck issue as one merely awaiting its turn (forge-dev ISS-576/ISS-652, paused 3 days unnoticed)
  it('reports run_not_running for a queued job under a paused run', async () => {
    const { project } = await seedProject({ maxConcurrentIssues: 5 });
    const issueId = await insertIssue(project.id);
    const jobId = await insertJob(project.id, { issueId, status: 'queued', type: 'plan' });
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'paused'
      WHERE id = (SELECT pipeline_run_id FROM jobs WHERE id = ${jobId})
    `);

    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    const health = map.get(issueId);
    expect(health?.waitingOn?.reason).toBe('run_not_running');
    expect(health?.waitingOn?.details.runStatus).toBe('paused');
  });

  // cm:guard the ONLY end-to-end proof of ISS-853 — `loadPausedRunsByIssue` reads `pipeline_runs` by issue id, so it is the one loader with no job row to join through, and the unit suite mocks drizzle away entirely. Delete this and the SQL that closes the blind spot is exercised nowhere.
  it('reports the paused run for an issue with NO job at all (ISS-853)', async () => {
    const { project } = await seedProject({ maxConcurrentIssues: 5 });
    const issueId = await insertIssue(project.id, { status: 'approved' });
    const runId = await getOrCreateRun(project.id, issueId);
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'paused' WHERE id = ${runId}`);

    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    const health = map.get(issueId);
    expect(health?.waitingOn).toBeUndefined();
    expect(health?.pausedRun?.runId).toBe(runId);
    expect(health?.pausedRun?.pauseReason).toBeNull();
    expect(health?.pausedRun?.resumer).toBe('operator');
  });

  it('reads a machine pause reason apart into its kind, detail and resumer', async () => {
    const { project } = await seedProject({ maxConcurrentIssues: 5 });
    const issueId = await insertIssue(project.id, { status: 'in_progress' });
    const runId = await getOrCreateRun(project.id, issueId);
    await harness.db.execute(sql`
      UPDATE pipeline_runs
      SET status = 'paused',
          metadata = COALESCE(metadata, '{}'::jsonb) || '{"pauseReason":"stage_stalled:code"}'::jsonb
      WHERE id = ${runId}
    `);

    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    const paused = map.get(issueId)?.pausedRun;
    expect(paused?.kind).toBe('stage_stalled');
    expect(paused?.detail).toBe('code');
    expect(paused?.resumer).toBe('operator');
  });

  it('leaves pausedRun unset while the run is still running', async () => {
    const { project } = await seedProject({ maxConcurrentIssues: 5 });
    const issueId = await insertIssue(project.id);
    await getOrCreateRun(project.id, issueId);

    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    expect(map.get(issueId)?.pausedRun).toBeUndefined();
  });

  it('reports runner_stale when the project has no fresh runner', async () => {
    const { project } = await seedProject({ maxConcurrentIssues: 5 });
    const issueId = await insertIssue(project.id);
    await insertJob(project.id, { issueId, status: 'queued', type: 'plan' });
    await harness.db.execute(
      sql`UPDATE runners SET status = 'offline' WHERE project_id = ${project.id}`,
    );

    const map = await mods.hydratePipelineHealthForIssues(project.id, [issueId]);
    const health = map.get(issueId);
    expect(health?.waitingOn?.reason).toBe('runner_stale');
    expect(health?.waitingOn?.details.freshRunners).toBe(0);
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
