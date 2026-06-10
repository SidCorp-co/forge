/**
 * W2.3.2 — Monthly budget gate E2E.
 *
 * Drives the real `handleDispatch` against real Postgres. Seeds the
 * `pipeline_run_step_durations` view's underlying tables (jobs +
 * pipeline_runs + agent_sessions + usage_records) to control the
 * month-to-date spend on (project, jobType) and asserts the dispatcher:
 *   - allows below 80%
 *   - emits a single warn at 80%
 *   - fails the job at 100% under action='pause' with the right metadata,
 *     and posts an operator comment
 *   - allows + warns at 100% under action='warn' (no enforcement)
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  handleDispatch: typeof import('../../src/jobs/dispatcher.js').handleDispatch;
  hooks: typeof import('../../src/pipeline/hooks.js').hooks;
  __resetBudgetWarnDedup: typeof import('../../src/jobs/budget-check.js').__resetBudgetWarnDedup;
};

describe('W2.3.2 monthly budget gate E2E', () => {
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
    const hooksMod = await import('../../src/pipeline/hooks.js');
    const budgetMod = await import('../../src/jobs/budget-check.js');
    mods = {
      handleDispatch: dispatcherMod.handleDispatch,
      hooks: hooksMod.hooks,
      __resetBudgetWarnDedup: budgetMod.__resetBudgetWarnDedup,
    };
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    mods.hooks.reset();
    mods.__resetBudgetWarnDedup();
  });

  afterEach(() => {
    mods.hooks.reset();
  });

  // ---------- helpers ---------------------------------------------------

  async function seedProjectWithBudget(opts: {
    perMonthUsd: number;
    action?: 'warn' | 'pause';
    stage?: string;
  }) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const stage = opts.stage ?? 'approved';
    const action = opts.action ?? 'pause';
    await harness.db.execute(sql`
      UPDATE projects
      SET agent_config = COALESCE(agent_config, '{}'::jsonb)
                       || jsonb_build_object(
                            'pipelineConfig',
                            COALESCE(agent_config -> 'pipelineConfig', '{}'::jsonb)
                              || jsonb_build_object(
                                   'states',
                                   jsonb_build_object(
                                     ${stage}::text,
                                     jsonb_build_object(
                                       'budget',
                                       jsonb_build_object(
                                         'perMonthUsd', ${opts.perMonthUsd}::numeric,
                                         'action', ${action}::text
                                       )
                                     )
                                   )
                                 ))
      WHERE id = ${project.id}
    `);
    await seedRunner(project.id, owner.id);
    return { owner, project, stage };
  }

  // Seed an online `claude-code` runner so the dispatch barrier (L4/L5) passes
  // and `handleDispatch` reaches the monthly-budget gate. Without it the
  // barrier short-circuits with `runner_stale` and the gate never runs.
  async function seedRunner(projectId: string, ownerId: string): Promise<void> {
    const device = await createTestDevice(harness.db, ownerId, { status: 'online' });
    const runnerId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${runnerId}, ${projectId}, 'claude-code', 'device', ${device.id},
        ${`runner-${runnerId.slice(0, 8)}`}, ${'{"pm": true}'}::jsonb,
        'online', now()
      )
    `);
  }

  async function insertIssue(projectId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', 'approved', 'medium',
        (SELECT created_by FROM projects WHERE id = ${projectId})
      )
    `);
    return id;
  }

  /**
   * Seed one historical completed job + agent_session + usage_record so the
   * `pipeline_run_step_durations` view rolls up to `costUsd` for this month.
   */
  async function seedHistoricalSpend(
    projectId: string,
    args: { costUsd: number; jobType?: string; issueId?: string | null },
  ): Promise<void> {
    const sessionId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
    const jobType = args.jobType ?? 'code';
    // pipeline_runs first — both agent_sessions.pipeline_run_id and
    // jobs.pipeline_run_id are NOT NULL (migration 0054) and FK this row.
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, status, started_at)
      VALUES (${runId}, ${projectId}, ${args.issueId ?? null}, 'completed', now())
    `);
    // jobs.started_at was dropped (migration 0057). The
    // pipeline_run_step_durations view now derives the step's started_at from
    // COALESCE(agent_sessions.started_at, jobs.dispatched_at); set the session's
    // started_at so the row falls in the current month, and use the job's
    // dispatched_at/finished_at (both required: the view filters on
    // finished_at IS NOT NULL).
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, started_at, metadata)
      VALUES (${sessionId}, ${projectId}, ${runId}, 'completed', now() - interval '10 minutes', '{}'::jsonb)
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status,
        payload, created_by, agent_session_id, pipeline_run_id,
        dispatched_at, finished_at, queued_at
      )
      VALUES (
        ${jobId}, ${projectId}, ${args.issueId ?? null}, ${jobType}, 'completed',
        '{}'::jsonb,
        (SELECT created_by FROM projects WHERE id = ${projectId}),
        ${sessionId}, ${runId},
        now() - interval '10 minutes', now() - interval '5 minutes', now() - interval '11 minutes'
      )
    `);
    await harness.db.execute(sql`
      INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at, session_id)
      VALUES (
        ${randomUUID()}, ${projectId}, 'cli', 'sonnet', ${args.costUsd}::real,
        now(), ${sessionId}
      )
    `);
  }

  async function insertQueuedJob(
    projectId: string,
    args: {
      issueId: string | null;
      type?: string;
      stageStatus?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    const type = args.type ?? 'code';
    const payload = JSON.stringify({ stageStatus: args.stageStatus ?? 'approved' });
    // jobs.pipeline_run_id is NOT NULL (migration 0054); the run is left
    // `running` so the job under test is treated as live by the dispatcher.
    // Reuse the issue's existing open run when one is present — a single issue
    // may have at most one open run (`pipeline_runs_issue_open_uq`), and tests
    // that dispatch two jobs for the same issue share that run.
    const runId = await (async () => {
      if (args.issueId) {
        const existing = await harness.db.execute<{ id: string }>(sql`
          SELECT id FROM pipeline_runs
          WHERE issue_id = ${args.issueId} AND status IN ('running', 'paused')
          LIMIT 1
        `);
        const found = (existing[0] as { id: string } | undefined)?.id;
        if (found) return found;
      }
      const newRunId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
        VALUES (
          ${newRunId}, ${projectId}, ${args.issueId},
          ${args.issueId ? 'issue' : 'system'}, 'running', now()
        )
      `);
      return newRunId;
    })();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status,
        payload, created_by, pipeline_run_id, queued_at
      )
      VALUES (
        ${id}, ${projectId}, ${args.issueId}, ${type}, 'queued',
        ${payload}::jsonb,
        (SELECT created_by FROM projects WHERE id = ${projectId}),
        ${runId}, now()
      )
    `);
    return id;
  }

  async function getJob(jobId: string): Promise<{
    status: string;
    failureReason: string | null;
    failureMeta: Record<string, unknown> | null;
  } | null> {
    const rows = await harness.db.execute<{
      status: string;
      failure_reason: string | null;
      failure_meta: Record<string, unknown> | null;
    }>(sql`
      SELECT status, failure_reason, failure_meta
      FROM jobs WHERE id = ${jobId}
    `);
    const r = rows[0];
    if (!r) return null;
    return { status: r.status, failureReason: r.failure_reason, failureMeta: r.failure_meta };
  }

  // ---------- action='pause' --------------------------------------------

  it('allows dispatch when spend is below 80% of cap (action=pause)', async () => {
    const { project } = await seedProjectWithBudget({ perMonthUsd: 1.0, action: 'pause' });
    const issueId = await insertIssue(project.id);
    await seedHistoricalSpend(project.id, { costUsd: 0.4, jobType: 'code', issueId });

    const warnPayloads: unknown[] = [];
    const breachPayloads: unknown[] = [];
    mods.hooks.on('pipeline.budgetWarning', (p) => {
      warnPayloads.push(p);
    });
    mods.hooks.on('pipeline.budgetBreach', (p) => {
      breachPayloads.push(p);
    });

    const jobId = await insertQueuedJob(project.id, { issueId, type: 'code' });
    // The dispatcher will continue past the budget gate; we don't care
    // whether it ultimately dispatches (no runner online) — only that the
    // gate did NOT fail the job and did NOT emit any hooks.
    await mods.handleDispatch({ jobId });

    expect(warnPayloads).toHaveLength(0);
    expect(breachPayloads).toHaveLength(0);
    const after = await getJob(jobId);
    expect(after?.failureReason).not.toBe('monthly_budget_exhausted');
  });

  it('emits a single budgetWarning at 80% spend (deduped per hour)', async () => {
    const { project } = await seedProjectWithBudget({ perMonthUsd: 1.0, action: 'pause' });
    const issueId = await insertIssue(project.id);
    await seedHistoricalSpend(project.id, { costUsd: 0.9, jobType: 'code', issueId });

    const warnPayloads: Array<Record<string, unknown>> = [];
    const breachPayloads: unknown[] = [];
    mods.hooks.on('pipeline.budgetWarning', (p) => {
      warnPayloads.push(p as Record<string, unknown>);
    });
    mods.hooks.on('pipeline.budgetBreach', (p) => {
      breachPayloads.push(p);
    });

    // Two dispatches in the same hour bucket — only the first should warn.
    const jobA = await insertQueuedJob(project.id, { issueId, type: 'code' });
    await mods.handleDispatch({ jobId: jobA });
    // Free the (issue_id, type) active-unique slot (jobs_active_unique covers
    // queued|dispatched|running) so the second job can be inserted for the same
    // issue+type. The warn dedup is in-process per (project, stage, hour), so
    // terminating jobA does not reset it.
    await harness.db.execute(sql`UPDATE jobs SET status = 'completed' WHERE id = ${jobA}`);
    const jobB = await insertQueuedJob(project.id, { issueId, type: 'code' });
    await mods.handleDispatch({ jobId: jobB });

    expect(warnPayloads).toHaveLength(1);
    expect(warnPayloads[0]).toMatchObject({
      projectId: project.id,
      stageStatus: 'approved',
      jobType: 'code',
      budget: 1,
    });
    const firstWarn = warnPayloads[0];
    if (!firstWarn) throw new Error('expected at least one warn payload');
    expect((firstWarn.spent as number) ?? 0).toBeGreaterThanOrEqual(0.8);
    expect(breachPayloads).toHaveLength(0);

    // Job rows themselves stay non-failed by the budget path (downstream
    // dispatcher may skip for unrelated reasons like missing runner).
    const after = await getJob(jobA);
    expect(after?.failureReason).not.toBe('monthly_budget_exhausted');
  });

  it('fails the job + emits budgetBreach + posts a comment at ≥100% under action=pause', async () => {
    const { project } = await seedProjectWithBudget({ perMonthUsd: 1.0, action: 'pause' });
    const issueId = await insertIssue(project.id);
    await seedHistoricalSpend(project.id, { costUsd: 1.1, jobType: 'code', issueId });

    const breachPayloads: Array<Record<string, unknown>> = [];
    mods.hooks.on('pipeline.budgetBreach', (p) => {
      breachPayloads.push(p as Record<string, unknown>);
    });

    const jobId = await insertQueuedJob(project.id, { issueId, type: 'code' });
    const result = await mods.handleDispatch({ jobId });

    expect(result).toBe('skipped');
    const after = await getJob(jobId);
    expect(after?.status).toBe('failed');
    expect(after?.failureReason).toBe('monthly_budget_exhausted');
    expect(after?.failureMeta).toMatchObject({ budget: 1, stageStatus: 'approved' });
    expect((after?.failureMeta as { spent?: number } | null)?.spent).toBeGreaterThanOrEqual(1);

    expect(breachPayloads).toHaveLength(1);
    expect(breachPayloads[0]).toMatchObject({
      projectId: project.id,
      stageStatus: 'approved',
      jobType: 'code',
      jobId,
      issueId,
      budget: 1,
    });

    // One operator comment posted on the issue. The `comments.is_ai` flag was
    // removed; the budget comment is authored by the project owner, so assert
    // body + a non-null author_id instead.
    const commentRows = await harness.db.execute<{ body: string; author_id: string | null }>(sql`
      SELECT body, author_id FROM comments WHERE issue_id = ${issueId}
    `);
    expect(commentRows.length).toBeGreaterThanOrEqual(1);
    expect(commentRows[0]?.body).toContain('Budget cap reached');
    expect(commentRows[0]?.author_id).toBeTruthy();
  });

  // ---------- action='warn' (no enforcement) -----------------------------

  it('does NOT fail the job at ≥100% under action=warn — emits only budgetWarning', async () => {
    const { project } = await seedProjectWithBudget({ perMonthUsd: 1.0, action: 'warn' });
    const issueId = await insertIssue(project.id);
    await seedHistoricalSpend(project.id, { costUsd: 1.1, jobType: 'code', issueId });

    const warnPayloads: unknown[] = [];
    const breachPayloads: unknown[] = [];
    mods.hooks.on('pipeline.budgetWarning', (p) => {
      warnPayloads.push(p);
    });
    mods.hooks.on('pipeline.budgetBreach', (p) => {
      breachPayloads.push(p);
    });

    const jobId = await insertQueuedJob(project.id, { issueId, type: 'code' });
    await mods.handleDispatch({ jobId });

    expect(breachPayloads).toHaveLength(0);
    expect(warnPayloads).toHaveLength(1);
    const after = await getJob(jobId);
    expect(after?.failureReason).not.toBe('monthly_budget_exhausted');
  });

  // ---------- no budget configured ---------------------------------------

  it('passes through cleanly when no budget is configured on the stage', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await seedRunner(project.id, owner.id);
    const issueId = await insertIssue(project.id);
    // Plenty of spend, but no budget → no gate.
    await seedHistoricalSpend(project.id, { costUsd: 999, jobType: 'code', issueId });

    const warnPayloads: unknown[] = [];
    const breachPayloads: unknown[] = [];
    mods.hooks.on('pipeline.budgetWarning', (p) => {
      warnPayloads.push(p);
    });
    mods.hooks.on('pipeline.budgetBreach', (p) => {
      breachPayloads.push(p);
    });

    const jobId = await insertQueuedJob(project.id, { issueId, type: 'code' });
    await mods.handleDispatch({ jobId });

    expect(warnPayloads).toHaveLength(0);
    expect(breachPayloads).toHaveLength(0);
    const after = await getJob(jobId);
    expect(after?.failureReason).not.toBe('monthly_budget_exhausted');
  });
});
