/**
 * ISS-573 / ISS-787 / ISS-931 — `resolveMachineTokenContext` against real Postgres.
 *
 * The resolver used to require `jobs.status = 'running'`, a value nothing in
 * core ever writes (queued → dispatched → terminal). Every agent-facing caller
 * therefore resolved null forever: `forge_ux_findings` rejected every write with
 * `no_active_issue` (zero rows on every project since the feature shipped) and
 * `forge_feedback` stamped null issueId/runId/jobId/stage on all of its reports.
 * The first test below is the one that reproduces that: a `dispatched` job under
 * a `queued` session is exactly the state a pipeline agent calls a tool from.
 *
 * ISS-931 changed the KEY from `devices.id` to the caller's own token. The
 * status predicates are unchanged and still asserted here; what is new is that
 * a `job:` token names one job, so the "most recently dispatched wins" guess
 * the device key forced is gone — and a `session:` token, which has no device
 * to look up, resolves at all.
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

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  resolvePipelineContext: typeof import('../../src/jobs/active-job-context.js').resolvePipelineContext;
};

describe('resolvePipelineContext E2E (ISS-573, re-keyed ISS-932 wave 4)', () => {
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

    mods = (await import('../../src/jobs/active-job-context.js')) as unknown as Mods;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed(opts: {
    sessionStatus?: string;
    jobStatus?: string;
    jobType?: string;
    withIssue?: boolean;
    dispatchedAt?: string;
  }) {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id);

    let issueId: string | null = null;
    if (opts.withIssue !== false) {
      issueId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, title, status, created_by_id)
        VALUES (${issueId}, ${project.id}, 'active-job-context probe', 'in_progress', ${owner.id})
      `);
    }

    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${project.id}, ${issueId}, ${issueId ? 'issue' : 'pm'}, 'running', now())
    `);

    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, status, pipeline_run_id)
      VALUES (${sessionId}, ${project.id}, ${device.id}, ${opts.sessionStatus ?? 'queued'}, ${runId})
    `);

    const jobId = randomUUID();
    // cm:guard stamp `device_id` on the JOB, not only on the session — `startJobForMaster` (devices/claim.ts) sets status, device_id, runner_id and dispatched_at in ONE statement, so a dispatched job with a null device_id is a state core never writes, and a fixture omitting it makes `resolveMachineTokenContext` look like it loses the device (that is exactly how this suite went red in CI).
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status, device_id, agent_session_id,
        pipeline_run_id, payload, queued_at, dispatched_at, created_by
      )
      VALUES (
        ${jobId}, ${project.id}, ${issueId}, ${opts.jobType ?? 'review'},
        ${opts.jobStatus ?? 'dispatched'}, ${device.id}, ${sessionId}, ${runId},
        '{}'::jsonb, now(), ${opts.dispatchedAt ?? new Date().toISOString()}, ${owner.id}
      )
    `);

    return { deviceId: device.id, projectId: project.id, issueId, runId, jobId, sessionId, owner };
  }

  const caller = (deviceId: string | null, boundProjectId: string | null) => ({
    deviceId,
    boundProjectId,
  });

  // cm:guard this is the ISS-573 reproduction — `dispatched` job + `queued` session is the ordinary state a pipeline agent calls an MCP tool from, and the old `jobs.status = 'running'` predicate matched it never
  it('resolves a dispatched job under a queued session, from the box and the project alone', async () => {
    const s = await seed({ sessionStatus: 'queued', jobStatus: 'dispatched' });
    const got = await mods.resolvePipelineContext(caller(s.deviceId, s.projectId));
    expect(got).toEqual({
      ok: true,
      context: {
        agentSessionId: s.sessionId,
        jobId: s.jobId,
        runId: s.runId,
        issueId: s.issueId,
        stage: 'review',
        deviceId: s.deviceId,
      },
    });
  });

  it('refuses a credential that names no box', async () => {
    const s = await seed({});
    const got = await mods.resolvePipelineContext(caller(null, s.projectId));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('not_pipeline_context');
  });

  it('refuses a credential that names a box but no project', async () => {
    const s = await seed({});
    const got = await mods.resolvePipelineContext(caller(s.deviceId, null));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('not_pipeline_context');
  });

  // cm:guard the ambiguous case REFUSES and writes nothing. Its predecessor took "the most recently dispatched job on that box" and mis-attributed every call on a runner at concurrency 3 (ISS-931) — a guess that is right most of the time is the failure mode, because nothing downstream can tell the wrong writes from the right ones.
  it('refuses by name when the box runs two sessions for one project', async () => {
    const s = await seed({});
    const second = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, status, pipeline_run_id)
      VALUES (${second}, ${s.projectId}, ${s.deviceId}, 'running', ${s.runId})
    `);
    const got = await mods.resolvePipelineContext(caller(s.deviceId, s.projectId));
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe('ambiguous_pipeline_context');
  });

  // cm:guard ISS-557 — a steward or schedule run is a session with NO job row, and it must still resolve so its reports carry a session id. A job-first lookup answers nothing here.
  it('resolves a session that is running no job, with the job fields null', async () => {
    const s = await seed({});
    await harness.db.execute(sql`DELETE FROM jobs WHERE id = ${s.jobId}`);
    const got = await mods.resolvePipelineContext(caller(s.deviceId, s.projectId));
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.context.agentSessionId).toBe(s.sessionId);
      expect(got.context.jobId).toBeNull();
      expect(got.context.issueId).toBeNull();
    }
  });

  it('carries the job type through as the stage', async () => {
    const s = await seed({ jobType: 'test' });
    const got = await mods.resolvePipelineContext(caller(s.deviceId, s.projectId));
    expect(got.ok && got.context.stage).toBe('test');
  });

  it('resolves a job with no issue (pm/system runs) with issueId null', async () => {
    const s = await seed({ withIssue: false, jobType: 'pm' });
    const got = await mods.resolvePipelineContext(caller(s.deviceId, s.projectId));
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.context.issueId).toBeNull();
  });

  it.each(['completed', 'failed', 'cancelled_stale'])(
    'refuses when the session is terminal (%s)',
    async (sessionStatus) => {
      const s = await seed({ sessionStatus });
      const got = await mods.resolvePipelineContext(caller(s.deviceId, s.projectId));
      expect(got.ok).toBe(false);
    },
  );

  it.each(['done', 'failed', 'cancelled', 'queued'])(
    'still resolves the session when its job is %s, with the job fields null',
    async (jobStatus) => {
      const s = await seed({ jobStatus });
      const got = await mods.resolvePipelineContext(caller(s.deviceId, s.projectId));
      expect(got.ok).toBe(true);
      if (got.ok) expect(got.context.jobId).toBeNull();
    },
  );

  // cm:guard the project half of the fence is load-bearing, not decoration: one box serves many projects, so a credential bound to B must never resolve A's session.
  it('does not resolve another project running on the same box', async () => {
    const mine = await seed({});
    const theirs = await seed({});
    await harness.db.execute(
      sql`UPDATE agent_sessions SET device_id = ${mine.deviceId} WHERE id = ${theirs.sessionId}`,
    );
    const got = await mods.resolvePipelineContext(caller(mine.deviceId, theirs.projectId));
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.context.agentSessionId).toBe(theirs.sessionId);
  });
});
