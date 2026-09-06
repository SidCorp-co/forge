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
  resolveMachineTokenContext: typeof import('../../src/jobs/active-job-context.js').resolveMachineTokenContext;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  resolveMachineTokenDeviceId: typeof import('../../src/jobs/active-job-context.js').resolveMachineTokenDeviceId;
};

describe('resolveMachineTokenContext E2E (ISS-573, re-keyed ISS-931)', () => {
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
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status, agent_session_id,
        pipeline_run_id, payload, queued_at, dispatched_at, created_by
      )
      VALUES (
        ${jobId}, ${project.id}, ${issueId}, ${opts.jobType ?? 'review'},
        ${opts.jobStatus ?? 'dispatched'}, ${sessionId}, ${runId},
        '{}'::jsonb, now(), ${opts.dispatchedAt ?? new Date().toISOString()}, ${owner.id}
      )
    `);

    return { deviceId: device.id, projectId: project.id, issueId, runId, jobId, sessionId, owner };
  }

  const jobRef = (id: string) => ({ kind: 'job' as const, id });
  const sessionRef = (id: string) => ({ kind: 'session' as const, id });

  // cm:guard this is the ISS-573 reproduction — `dispatched` job + `queued` session is the ordinary state a pipeline agent calls an MCP tool from, and the old `jobs.status = 'running'` predicate matched it never
  it('resolves a dispatched job under a queued session', async () => {
    const s = await seed({ sessionStatus: 'queued', jobStatus: 'dispatched' });
    await expect(mods.resolveMachineTokenContext(sessionRef(s.sessionId))).resolves.toEqual({
      jobId: s.jobId,
      runId: s.runId,
      issueId: s.issueId,
      stage: 'review',
      deviceId: s.deviceId,
      agentSessionId: s.sessionId,
    });
  });

  it('a job token resolves its own job directly', async () => {
    const s = await seed({ sessionStatus: 'queued', jobStatus: 'dispatched' });
    await expect(mods.resolveMachineTokenContext(jobRef(s.jobId))).resolves.toEqual({
      jobId: s.jobId,
      runId: s.runId,
      issueId: s.issueId,
      stage: 'review',
      deviceId: s.deviceId,
      agentSessionId: s.sessionId,
    });
  });

  it('resolves nothing for a token that names no job or session', async () => {
    await expect(mods.resolveMachineTokenContext(null)).resolves.toBeNull();
    await expect(mods.resolveMachineTokenDeviceId(null)).resolves.toBeNull();
  });

  it('resolves the device a job and a session run on', async () => {
    const s = await seed({});
    await expect(mods.resolveMachineTokenDeviceId(jobRef(s.jobId))).resolves.toBe(s.deviceId);
    await expect(mods.resolveMachineTokenDeviceId(sessionRef(s.sessionId))).resolves.toBe(
      s.deviceId,
    );
  });

  it('resolves once the session has flipped to running on its first event batch', async () => {
    const s = await seed({ sessionStatus: 'running', jobStatus: 'dispatched' });
    const active = await mods.resolveMachineTokenContext(sessionRef(s.sessionId));
    expect(active?.jobId).toBe(s.jobId);
  });

  it('carries the job type through as the stage', async () => {
    const s = await seed({ jobType: 'test' });
    const active = await mods.resolveMachineTokenContext(jobRef(s.jobId));
    expect(active?.stage).toBe('test');
  });

  it('resolves a job with no issue (pm/system runs) with issueId null', async () => {
    const s = await seed({ withIssue: false, jobType: 'pm' });
    const active = await mods.resolveMachineTokenContext(jobRef(s.jobId));
    expect(active).not.toBeNull();
    expect(active?.issueId).toBeNull();
  });

  it.each(['done', 'failed', 'cancelled', 'queued'])(
    'returns null for a job in status %s',
    async (jobStatus) => {
      const s = await seed({ jobStatus });
      await expect(mods.resolveMachineTokenContext(jobRef(s.jobId))).resolves.toBeNull();
      await expect(mods.resolveMachineTokenContext(sessionRef(s.sessionId))).resolves.toBeNull();
    },
  );

  it.each(['completed', 'failed', 'cancelled_stale'])(
    'returns null when the session is terminal (%s)',
    async (sessionStatus) => {
      const s = await seed({ sessionStatus });
      await expect(mods.resolveMachineTokenContext(sessionRef(s.sessionId))).resolves.toBeNull();
    },
  );

  it('returns null for an id that names no row at all', async () => {
    await expect(mods.resolveMachineTokenContext(jobRef(randomUUID()))).resolves.toBeNull();
    await expect(mods.resolveMachineTokenContext(sessionRef(randomUUID()))).resolves.toBeNull();
  });

  it('does not leak another job', async () => {
    const mine = await seed({});
    const theirs = await seed({});
    const active = await mods.resolveMachineTokenContext(jobRef(mine.jobId));
    expect(active?.jobId).toBe(mine.jobId);
    expect(active?.jobId).not.toBe(theirs.jobId);
  });

  // cm:guard this is the ISS-931 improvement stated as a test, and it must keep failing on the old behaviour: TWO in-flight jobs on one box, and a `job:` token resolves the one it NAMES rather than the newest. The device key could not do this — it took `order by dispatched_at desc limit 1`, so a tool call from the older job was attributed to the newer one.
  it('a job token resolves the job it names, not the newest on the same box', async () => {
    const older = await seed({ dispatchedAt: new Date(Date.now() - 60_000).toISOString() });

    // cm:why a second in-flight job on the SAME device needs its own session + run — that is the real shape when a runner's cap is above 1
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${older.projectId}, NULL, 'pm', 'running', now())
    `);
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, device_id, status, pipeline_run_id)
      VALUES (${sessionId}, ${older.projectId}, ${older.deviceId}, 'running', ${runId})
    `);
    const newerJobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, type, status, agent_session_id,
        pipeline_run_id, payload, queued_at, dispatched_at, created_by
      )
      VALUES (
        ${newerJobId}, ${older.projectId}, NULL, 'pm', 'dispatched', ${sessionId}, ${runId},
        '{}'::jsonb, now(), now(), ${older.owner.id}
      )
    `);

    await expect(mods.resolveMachineTokenContext(jobRef(older.jobId))).resolves.toMatchObject({
      jobId: older.jobId,
    });
    await expect(mods.resolveMachineTokenContext(jobRef(newerJobId))).resolves.toMatchObject({
      jobId: newerJobId,
    });

    // cm:why the session key is the one that still has to guess: a session can have run several jobs, so `resolveMachineTokenContext` prefers the newest — only the `job:` key above is exact
    await expect(mods.resolveMachineTokenContext(sessionRef(sessionId))).resolves.toMatchObject({
      jobId: newerJobId,
    });
  });
});
