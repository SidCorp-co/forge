/**
 * ISS-1133 — the run journal behind the old phase and handoff surfaces, against a real Postgres.
 *
 * One row per (run, phase, attempt): a handoff fills the attempt the run declared, an end and a
 * handoff are each written once and a second is refused by name, the handoff routes answer in the
 * shape they always did, and a job's completion is judged by when its handoff was written.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs } from '../../src/db/schema.js';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let hasTerminalHandoffForAttempt: typeof import('../../src/jobs/finalize-done.js').hasTerminalHandoffForAttempt;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [phases, handoffs, journal, errMod, reqIdMod, jwt, finalize] = await Promise.all([
    import('../../src/pipeline/phase-routes.js'),
    import('../../src/pipeline/step-handoff-routes.js'),
    import('../../src/pipeline/run-journal-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/jobs/finalize-done.js'),
  ]);
  signUserToken = jwt.signUserToken;
  hasTerminalHandoffForAttempt = finalize.hasTerminalHandoffForAttempt;
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', reqIdMod.requestId());
  app.route('/api/pipeline-runs', phases.phaseRoutes);
  app.route('/api/issue-step-contexts', handoffs.stepHandoffRoutes);
  app.route('/api/run-journal', journal.runJournalRoutes);
  app.onError(errMod.errorHandler);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

type World = { projectId: string; issueId: string; runId: string; userId: string; token: string };

async function seed(): Promise<World> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}::uuid`,
  );
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, created_by_id, status)
    VALUES (${issueId}::uuid, ${project.id}::uuid, 'a run that writes its journal', ${user.id}::uuid, 'in_progress')
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
    VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running', now())
  `);
  return {
    projectId: project.id,
    issueId,
    runId,
    userId: user.id,
    token: await signUserToken(user.id),
  };
}

const call = (w: World, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${w.token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const drivePayload = (summary: string) => ({
  step: 'drive',
  schema_version: 1,
  outcome: 'advanced',
  summary,
  workDone: ['the change'],
  openQuestions: [],
});

const writeHandoff = (w: World, summary: string, attempt = 1) =>
  call(w, 'POST', '/api/issue-step-contexts', {
    projectId: w.projectId,
    issueId: w.issueId,
    pipelineRunId: w.runId,
    step: 'drive',
    attempt,
    payload: drivePayload(summary),
  });

async function journalRows(runId: string) {
  return (await harness.db.execute(sql`
    SELECT phase, attempt, outcome, handoff, handoff_at, ended_at FROM run_journal
    WHERE run_id = ${runId} ORDER BY started_at, attempt
  `)) as unknown as Array<{
    phase: string;
    attempt: number;
    outcome: string | null;
    handoff: Record<string, unknown> | null;
    handoff_at: Date | null;
    ended_at: Date | null;
  }>;
}

describe('one row per attempt (criteria 9, 12)', () => {
  it('fills the attempt a session declared with its handoff, rather than adding a row', async () => {
    const w = await seed();
    const started = await call(w, 'POST', `/api/pipeline-runs/${w.runId}/phases`, {
      phase: 'drive',
    });
    expect(started.status).toBe(201);
    expect((await writeHandoff(w, 'pushed the branch')).status).toBe(201);

    const rows = await journalRows(w.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'drive', attempt: 1, ended_at: null });
    expect(rows[0]?.handoff).toMatchObject({ summary: 'pushed the branch' });
  });

  it('answers the old handoff list in its old shape, read from the journal', async () => {
    const w = await seed();
    await writeHandoff(w, 'pushed the branch');
    const res = await call(
      w,
      'GET',
      `/api/issue-step-contexts?projectId=${w.projectId}&issueId=${w.issueId}`,
    );
    expect(res.status).toBe(200);
    const { rows } = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      issueId: w.issueId,
      pipelineRunId: w.runId,
      kind: 'handoff',
      step: 'drive',
      attempt: 1,
      payload: { summary: 'pushed the branch' },
    });
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'attempt',
      'createdAt',
      'id',
      'issueId',
      'kind',
      'payload',
      'pipelineRunId',
      'projectId',
      'step',
      'updatedAt',
    ]);
  });
});

describe('nothing in a row is written twice', () => {
  it('refuses a second handoff for the attempt by name, and the first stands (criterion 11)', async () => {
    const w = await seed();
    expect((await writeHandoff(w, 'the first')).status).toBe(201);

    const second = await writeHandoff(w, 'the second');

    expect(second.status).toBe(409);
    expect(JSON.stringify(await second.json())).toContain('HANDOFF_ALREADY_WRITTEN');
    const rows = await journalRows(w.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.handoff).toMatchObject({ summary: 'the first' });
  });

  it('takes a later round as a new attempt', async () => {
    const w = await seed();
    await writeHandoff(w, 'round one', 1);
    expect((await writeHandoff(w, 'round two', 2)).status).toBe(201);
    expect((await journalRows(w.runId)).map((r) => r.attempt)).toEqual([1, 2]);
  });

  it('refuses a second end by name, naming the outcome the attempt keeps (criterion 18)', async () => {
    const w = await seed();
    await call(w, 'POST', `/api/pipeline-runs/${w.runId}/phases`, { phase: 'implement' });
    const end = (outcome: string) =>
      call(w, 'POST', `/api/pipeline-runs/${w.runId}/phases/end`, {
        phase: 'implement',
        attempt: 1,
        outcome,
      });
    expect((await end('ok')).status).toBe(200);

    const second = await end('failed');

    expect(second.status).toBe(409);
    const body = JSON.stringify(await second.json());
    expect(body).toContain('PHASE_ALREADY_ENDED');
    expect(body).toContain('already ended `ok`');
    expect((await journalRows(w.runId))[0]?.outcome).toBe('ok');
  });

  it('refuses an end of an attempt never started, by name', async () => {
    const w = await seed();
    const res = await call(w, 'POST', `/api/pipeline-runs/${w.runId}/phases/end`, {
      phase: 'implement',
      attempt: 3,
      outcome: 'ok',
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).toContain('PHASE_NOT_FOUND');
  });

  it('refuses a handoff delete by name and keeps the handoff (criterion 12)', async () => {
    const w = await seed();
    await writeHandoff(w, 'kept');
    const res = await call(
      w,
      'DELETE',
      `/api/issue-step-contexts?projectId=${w.projectId}&issueId=${w.issueId}&step=drive&attempt=1`,
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('HANDOFF_IS_JOURNAL');
    expect((await journalRows(w.runId))[0]?.handoff).toMatchObject({ summary: 'kept' });
  });

  it('refuses in the database an end without its outcome, and a handoff without its time', async () => {
    const w = await seed();
    await expect(
      harness.db.execute(sql`
        INSERT INTO run_journal (project_id, run_id, phase, source, ended_at)
        VALUES (${w.projectId}, ${w.runId}, 'x', 'agent', now())`),
    ).rejects.toThrow();
    await expect(
      harness.db.execute(sql`
        INSERT INTO run_journal (project_id, run_id, phase, source, handoff)
        VALUES (${w.projectId}, ${w.runId}, 'y', 'agent', '{}'::jsonb)`),
    ).rejects.toThrow();
  });
});

describe("a job's completion is judged by when its handoff was written (criteria 14, 19)", () => {
  async function aJob(w: World, dispatchedAgoMin: number) {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, payload, dispatched_at)
      VALUES (${id}, ${w.projectId}, ${w.issueId}, ${w.runId}, ${w.userId}, 'drive', 'running',
              '{"promptString":"x"}'::jsonb, now() - make_interval(mins => ${dispatchedAgoMin}::int))`);
    const [row] = await harness.db.select().from(jobs).where(eq(jobs.id, id));
    return row as NonNullable<typeof row>;
  }

  it('counts a handoff written after dispatch on an attempt that ended before it', async () => {
    const w = await seed();
    await harness.db.execute(sql`
      INSERT INTO run_journal (project_id, run_id, issue_id, phase, source, outcome, started_at, ended_at, handoff, handoff_at)
      VALUES (${w.projectId}, ${w.runId}, ${w.issueId}, 'drive', 'agent', 'ok',
              now() - interval '60 minutes', now() - interval '50 minutes',
              '{"step":"drive"}'::jsonb, now() - interval '5 minutes')`);
    expect(await hasTerminalHandoffForAttempt(await aJob(w, 30))).toBe(true);
  });

  it('does not count a handoff written before dispatch on an attempt that ended after it', async () => {
    const w = await seed();
    await harness.db.execute(sql`
      INSERT INTO run_journal (project_id, run_id, issue_id, phase, source, outcome, started_at, ended_at, handoff, handoff_at)
      VALUES (${w.projectId}, ${w.runId}, ${w.issueId}, 'drive', 'agent', 'ok',
              now() - interval '60 minutes', now() - interval '5 minutes',
              '{"step":"drive"}'::jsonb, now() - interval '50 minutes')`);
    expect(await hasTerminalHandoffForAttempt(await aJob(w, 30))).toBe(false);
  });
});

describe('the issue page reads one record of what a run did', () => {
  it('answers each run with its attempts and the handoff each left', async () => {
    const w = await seed();
    const plan = await call(w, 'POST', `/api/pipeline-runs/${w.runId}/phases`, { phase: 'plan' });
    expect(plan.status).toBe(201);
    await call(w, 'POST', `/api/pipeline-runs/${w.runId}/phases/end`, {
      phase: 'plan',
      attempt: 1,
      outcome: 'ok',
    });
    await call(w, 'POST', `/api/pipeline-runs/${w.runId}/phases`, { phase: 'drive' });
    await writeHandoff(w, 'pushed the branch');

    const res = await call(
      w,
      'GET',
      `/api/run-journal?projectId=${w.projectId}&issueId=${w.issueId}`,
    );

    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as {
      runs: Array<{ runId: string; attempts: Array<Record<string, unknown>> }>;
    };
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe(w.runId);
    expect(runs[0]?.attempts.map((a) => [a.phase, a.outcome])).toEqual([
      ['plan', 'ok'],
      ['drive', null],
    ]);
    expect(runs[0]?.attempts[1]?.handoff).toMatchObject({ summary: 'pushed the branch' });
  });

  it('answers a run that recorded nothing, a phase with no issue on it, and every session of the run costed once', async () => {
    const w = await seed();
    const earlier = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at, finished_at)
      VALUES (${earlier}, ${w.projectId}, ${w.issueId}, 'issue', 'failed',
              now() - interval '2 hours', now() - interval '90 minutes')`);
    await harness.db.execute(sql`
      INSERT INTO run_journal (project_id, run_id, issue_id, phase, attempt, source, started_at)
      VALUES (${w.projectId}, ${w.runId}, NULL, 'implement', 1, 'agent', now())`);
    const session = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status, metadata)
      VALUES (${session}, ${w.projectId}, ${w.runId}, 'pipeline', 'running', '{}'::jsonb)`);
    for (const type of ['plan', 'drive']) {
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status, payload, agent_session_id)
        VALUES (${randomUUID()}, ${w.projectId}, ${w.issueId}, ${w.runId}, ${w.userId}, ${type}, 'done',
                '{"promptString":"x"}'::jsonb, ${session})`);
    }
    const jobless = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status, metadata)
      VALUES (${jobless}, ${w.projectId}, ${w.runId}, 'pipeline', 'completed', '{}'::jsonb)`);
    for (const [owner, cost] of [
      [session, 0.5],
      [session, 0.25],
      [jobless, 0.25],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO usage_records (id, project_id, source, model, estimated_cost, recorded_at, session_id)
        VALUES (${randomUUID()}, ${w.projectId}, 'cli', 'sonnet', ${cost}::real, now(), ${owner})`);
    }

    const res = await call(
      w,
      'GET',
      `/api/run-journal?projectId=${w.projectId}&issueId=${w.issueId}`,
    );

    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as {
      runs: Array<{
        runId: string;
        ordinal: number;
        status: string;
        costUsd: number | null;
        attempts: Array<Record<string, unknown>>;
      }>;
    };
    expect(runs.map((r) => [r.runId, r.ordinal, r.status, r.costUsd, r.attempts.length])).toEqual([
      [w.runId, 2, 'running', 1, 1],
      [earlier, 1, 'failed', null, 0],
    ]);
    expect(runs[0]?.attempts[0]).toMatchObject({ phase: 'implement', durationSeconds: null });
  });

  it('answers a group run the issue was opened in, holding only the attempts naming it', async () => {
    const w = await seed();
    const [keyRow] = (await harness.db.execute(
      sql`SELECT 'ISS-' || iss_seq AS key FROM issues WHERE id = ${w.issueId}`,
    )) as unknown as Array<{ key: string }>;
    const key = keyRow?.key ?? '';
    expect(key).toMatch(/^ISS-\d+$/);
    const other = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, created_by_id, status)
      VALUES (${other}::uuid, ${w.projectId}::uuid, 'another member', ${w.userId}::uuid, 'in_progress')`);
    const group = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at, metadata)
      VALUES (${group}, ${w.projectId}, NULL, 'system', 'running', now() + interval '1 minute',
              ${JSON.stringify({ type: 'run_session', runIssues: [key, 'ISS-999999'], runGroup: [key, 'ISS-999999'] })}::jsonb)`);
    const byStatuses = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at, metadata)
      VALUES (${byStatuses}, ${w.projectId}, NULL, 'system', 'completed', now() - interval '1 day',
              ${JSON.stringify({ type: 'run_session', runIssueStatuses: { [key]: 'open' } })}::jsonb)`);
    const elsewhere = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, metadata)
      VALUES (${elsewhere}, ${w.projectId}, NULL, 'system', 'running',
              ${JSON.stringify({ type: 'run_session', runGroup: ['ISS-999999'] })}::jsonb)`);
    await harness.db.execute(sql`
      INSERT INTO run_journal (project_id, run_id, issue_id, phase, attempt, source, started_at)
      VALUES (${w.projectId}, ${group}, ${w.issueId}, 'drive', 1, 'agent', now()),
             (${w.projectId}, ${group}, ${other}, 'drive', 2, 'agent', now()),
             (${w.projectId}, ${group}, NULL, 'recall', 1, 'agent', now())`);
    const [ended, newest] = [randomUUID(), randomUUID()];
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status, failure_reason, started_at, metadata)
      VALUES (${ended}, ${w.projectId}, ${group}, 'run_session', 'failed', 'user_cancelled', now() - interval '5 minutes', '{}'::jsonb),
             (${newest}, ${w.projectId}, ${group}, 'run_session', 'failed', 'user_cancelled', now(), '{}'::jsonb)`);

    const res = await call(
      w,
      'GET',
      `/api/run-journal?projectId=${w.projectId}&issueId=${w.issueId}`,
    );

    expect(res.status).toBe(200);
    const { runs } = (await res.json()) as {
      runs: Array<{
        runId: string;
        ordinal: number;
        group: string[] | null;
        sessionId: string | null;
        attempts: Array<{ phase: string; attempt: number }>;
      }>;
    };
    expect(runs.map((r) => [r.runId, r.ordinal, r.group, r.sessionId])).toEqual([
      [group, 3, [key, 'ISS-999999'], newest],
      [w.runId, 2, null, null],
      [byStatuses, 1, [key], null],
    ]);
    expect(runs[0]?.attempts.map((a) => `${a.phase}#${a.attempt}`)).toEqual(['drive#1']);
  });
});
