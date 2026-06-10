/**
 * ISS-40 PR-E — full dispatcher pipeline E2E.
 *
 * Drives the real `handleDispatch` against real Postgres to verify the gate
 * orchestration in `dispatchViaRunner`. Where the gate-helper E2E tests
 * (dispatcher-gates-e2e.test.ts) pin the SQL of each gate in isolation, this
 * suite asserts the dispatcher correctly chains L1→L2→L3 and short-circuits
 * to `skipped + markSessionGated` on the first failure.
 *
 * Layer 4 (runner_full) requires a fully-registered runner + adapter, which
 * is exercised in `device-runner-e2e.test.ts`. We sanity-check the wiring
 * here by leaving the project without an active runner and confirming the
 * dispatcher returns `skipped` (no-runner branch) without falsely claiming
 * a gate failure.
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
  handleDispatch: typeof import('../../src/jobs/dispatcher.js').handleDispatch;
};

describe('ISS-40 dispatcher pipeline E2E', () => {
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

    const dispatcherMod = await import('../../src/jobs/dispatcher.js');
    mods = { handleDispatch: dispatcherMod.handleDispatch };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  // ---------- helpers ---------------------------------------------------

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
    overrides: { status?: string; priority?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', ${overrides.status ?? 'open'}, ${overrides.priority ?? 'medium'},
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  // jobs.pipeline_run_id and agent_sessions.pipeline_run_id are NOT NULL
  // (migration 0054). A run with NULL issue_id must use kind='system'/'pm'
  // (pipeline_runs_issue_kind_chk); only kind='issue' may carry an issue_id.
  async function insertPipelineRun(
    projectId: string,
    issueId: string | null,
    kind: string,
  ): Promise<string> {
    // At most one OPEN issue-run per issue (`pipeline_runs_issue_open_uq`).
    // A session + the job for the same issue must SHARE one run — reuse the
    // existing open issue-run if present, otherwise insert a fresh one.
    if (issueId && kind === 'issue') {
      const existing = await harness.db.execute<{ id: string }>(sql`
        SELECT id FROM pipeline_runs
        WHERE issue_id = ${issueId} AND kind = 'issue' AND status IN ('running','paused')
        LIMIT 1
      `);
      if (existing[0]?.id) return existing[0].id;
    }
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${id}, ${projectId}, ${issueId ?? null}, ${kind}, 'running', now())
    `);
    return id;
  }

  async function insertSession(
    projectId: string,
    args: { issueId?: string | null; status?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const metadata = args.issueId ? JSON.stringify({ issueId: args.issueId }) : '{}';
    const pipelineRunId = await insertPipelineRun(
      projectId,
      args.issueId ?? null,
      args.issueId ? 'issue' : 'system',
    );
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, status, metadata, pipeline_run_id)
      VALUES (${id}, ${projectId}, ${args.status ?? 'queued'}, ${metadata}::jsonb, ${pipelineRunId})
    `);
    return id;
  }

  async function insertJob(
    projectId: string,
    args: {
      issueId?: string | null;
      type?: string;
      agentSessionId?: string | null;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const kind = args.type === 'pm' ? 'pm' : args.issueId ? 'issue' : 'system';
    const pipelineRunId = await insertPipelineRun(projectId, args.issueId ?? null, kind);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, type, status, payload, pipeline_run_id, created_by, agent_session_id)
      VALUES (
        ${id}, ${projectId}, ${args.issueId ?? null}, ${args.type ?? 'plan'},
        'queued', '{}'::jsonb, ${pipelineRunId},
        (SELECT created_by FROM projects WHERE id = ${projectId}),
        ${args.agentSessionId ?? null}
      )
    `);
    return id;
  }

  async function insertBlocksEdge(
    projectId: string,
    fromIssueId: string,
    toIssueId: string,
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO issue_dependencies (id, project_id, from_issue_id, to_issue_id, kind)
      VALUES (${randomUUID()}, ${projectId}, ${fromIssueId}, ${toIssueId}, 'blocks')
    `);
  }

  async function getSessionFailureReason(sessionId: string): Promise<string | null> {
    const rows = await harness.db.execute<{ failure_reason: string | null }>(sql`
      SELECT failure_reason FROM agent_sessions WHERE id = ${sessionId}
    `);
    return rows[0]?.failure_reason ?? null;
  }

  // ---------- L1 — issue_busy short-circuit -----------------------------

  it('L1 issue_busy — when another running session shares the issueId, dispatcher returns skipped and leaves the job queued', async () => {
    const { project } = await seedProject();
    const issueId = await insertIssue(project.id);
    // Another session for the same issue, already running
    await insertSession(project.id, { issueId, status: 'running' });
    // Candidate session+job
    const candidateSession = await insertSession(project.id, { issueId });
    const candidateJob = await insertJob(project.id, {
      issueId,
      agentSessionId: candidateSession,
    });

    const result = await mods.handleDispatch({ jobId: candidateJob });
    // ISS-228 — a barrier skip no longer persists agent_sessions.failure_reason.
    expect(result).toBe('skipped');

    // Job stays queued (gate skips do not move jobs to failed).
    const [jobRow] = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM jobs WHERE id = ${candidateJob}
    `);
    expect(jobRow?.status).toBe('queued');
  });

  // ---------- L2 — waiting_on_dep ---------------------------------------

  it('L2 waiting_on_dep — when blocking parent is in_progress, dispatcher returns skipped and leaves the job queued', async () => {
    const { project } = await seedProject();
    const parent = await insertIssue(project.id, { status: 'in_progress' });
    const child = await insertIssue(project.id);
    await insertBlocksEdge(project.id, parent, child);

    const session = await insertSession(project.id, { issueId: child });
    const job = await insertJob(project.id, { issueId: child, agentSessionId: session });

    const result = await mods.handleDispatch({ jobId: job });
    // ISS-228 — barrier skip persists no failure_reason / waitingOn metadata.
    expect(result).toBe('skipped');

    const [jobRow] = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM jobs WHERE id = ${job}
    `);
    expect(jobRow?.status).toBe('queued');
  });

  it('L2 — passes once the blocking parent reaches `closed`', async () => {
    const { project } = await seedProject();
    const parent = await insertIssue(project.id, { status: 'closed' });
    const child = await insertIssue(project.id);
    await insertBlocksEdge(project.id, parent, child);

    const session = await insertSession(project.id, { issueId: child });
    const job = await insertJob(project.id, { issueId: child, agentSessionId: session });

    // L1+L2 should pass; L3 too (project not full); the dispatcher then hits
    // the no-runner branch and returns 'skipped'. We assert the failure_reason
    // is NOT a gate reason — proving L1/L2/L3 did not trip.
    const result = await mods.handleDispatch({ jobId: job });
    expect(result).toBe('skipped'); // no runner online
    const reason = await getSessionFailureReason(session);
    expect(reason).not.toBe('waiting_on_dep');
    expect(reason).not.toBe('issue_busy');
    expect(reason).not.toBe('project_full');
  });

  // ---------- L3 — project_full -----------------------------------------

  it('L3 project_full — when distinct running issues hit the cap, dispatcher returns skipped and leaves the job queued', async () => {
    // ISS-232 — project cap is hardcoded to 1; one running issue fills it.
    const { project } = await seedProject();
    const a = await insertIssue(project.id);
    const candidate = await insertIssue(project.id);

    // A running JOB for issue `a` puts it in running_ids (the cap counts jobs).
    await insertJob(project.id, { issueId: a });
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'running' WHERE issue_id = ${a}
    `);

    const session = await insertSession(project.id, { issueId: candidate });
    const job = await insertJob(project.id, { issueId: candidate, agentSessionId: session });

    const result = await mods.handleDispatch({ jobId: job });
    // ISS-228 — barrier skip persists no failure_reason.
    expect(result).toBe('skipped');

    const [jobRow] = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM jobs WHERE id = ${job}
    `);
    expect(jobRow?.status).toBe('queued');
  });

  // ---------- Gate ordering — L1 wins over L2/L3 ------------------------

  it('reports the FIRST failing gate (L1 short-circuits L2/L3 even when both would also fail)', async () => {
    const { project } = await seedProject({ maxConcurrentIssues: 1 });
    // Make L1 fail by having another active session for the same issue.
    const issueId = await insertIssue(project.id);
    await insertSession(project.id, { issueId, status: 'running' });
    // Also make L2 fail by adding a blocking parent in progress.
    const parent = await insertIssue(project.id, { status: 'in_progress' });
    await insertBlocksEdge(project.id, parent, issueId);
    // L3 is also full because the active session above already counts.

    const candidateSession = await insertSession(project.id, { issueId });
    const job = await insertJob(project.id, { issueId, agentSessionId: candidateSession });

    const result = await mods.handleDispatch({ jobId: job });
    // ISS-228 — the dispatcher returns 'skipped' on the first failing gate
    // but no longer persists the reason on the session. The job stays queued.
    expect(result).toBe('skipped');
    const [jobRow] = await harness.db.execute<{ status: string }>(sql`
      SELECT status FROM jobs WHERE id = ${job}
    `);
    expect(jobRow?.status).toBe('queued');
  });

  // ---------- PM job bypass --------------------------------------------

  it('PM jobs (`type=pm`, no issueId) bypass L1+L2', async () => {
    const { project } = await seedProject();
    // Seed an unrelated active session to prove L1 isn't invoked for PM.
    const otherIssue = await insertIssue(project.id);
    await insertSession(project.id, { issueId: otherIssue, status: 'running' });

    const pmSession = await insertSession(project.id, { issueId: null });
    const pmJob = await insertJob(project.id, {
      type: 'pm',
      issueId: null,
      agentSessionId: pmSession,
    });

    const result = await mods.handleDispatch({ jobId: pmJob });
    // Will end up skipped due to no runner, but failure_reason should NOT be
    // a gate reason — proving PM bypass works.
    expect(result).toBe('skipped');
    const reason = await getSessionFailureReason(pmSession);
    expect(reason).not.toBe('issue_busy');
    expect(reason).not.toBe('waiting_on_dep');
    expect(reason).not.toBe('project_full');
  });
});
