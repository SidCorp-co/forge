import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  seedProjectDocument,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let mintPat: typeof import('../../src/auth/pat.js').mintPat;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let service: typeof import('../../src/project-config/service.js');

const ADMIN_PASSWORD = 'tester-admin-pass-7f3a';
const DB_PASSWORD = 'tester-db-pass-91c2';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.INTEGRATION_MASTER_KEY ??= randomBytes(32).toString('base64');
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const [routes, events, sessionEvents, errMod, reqIdMod, pat, jwt, svc] = await Promise.all([
    import('../../src/jobs/testing-secrets-routes.js'),
    import('../../src/jobs/events-routes.js'),
    import('../../src/agent-sessions/events-routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/middleware/request-id.js'),
    import('../../src/auth/pat.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/project-config/service.js'),
  ]);
  mintPat = pat.mintPat;
  signUserToken = jwt.signUserToken;
  service = svc;
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', reqIdMod.requestId());
  app.route('/api/jobs', routes.jobTestingSecretsRoutes);
  app.route('/api/jobs', events.jobEventsRoutes);
  app.use('/api/agent-sessions/*', async (c, next) => {
    c.set('deviceId' as never, c.req.header('x-test-device') as never);
    await next();
  });
  app.route('/api/agent-sessions', sessionEvents.agentSessionEventsRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seedJob(
  projectId: string,
  ownerId: string,
  type = 'test',
  landedOn: string | null = 'main',
) {
  const device = await createTestDevice(harness.db, ownerId);
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id, merged_at, merged_target)
    VALUES (${issueId}, ${projectId}, 'testing-secrets probe', 'in_progress', ${ownerId},
            ${landedOn ? sql`now()` : null}, ${landedOn})
  `);
  await harness.db.execute(sql`
    INSERT INTO issue_work_state (issue_id, step, step_started_at) VALUES (${issueId}, 'test', now())
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', now())
  `);
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, kind, status, pipeline_run_id)
    VALUES (${sessionId}, ${projectId}, ${device.id}, 'pipeline', 'running', ${runId})
  `);
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, type, status, device_id, agent_session_id,
                      pipeline_run_id, payload, queued_at, dispatched_at, created_by)
    VALUES (${jobId}, ${projectId}, ${issueId}, ${type}, 'running', ${device.id}, ${sessionId},
            ${runId}, '{}'::jsonb, now(), now(), ${ownerId})
  `);
  const { plaintext } = await mintPat({
    userId: ownerId,
    name: `job credential ${jobId}`,
    deviceId: device.id,
    boundProjectId: projectId,
  });
  return { jobId, sessionId, deviceId: device.id, credential: plaintext };
}

const environment = (testing?: string, deploysFrom = 'main') => ({
  tier: 'staging' as const,
  deploysFrom,
  deployment: { mode: 'external' as const },
  url: 'https://staging.example.com',
  ...(testing ? { testing } : {}),
});

async function seed(
  opts: {
    environments?: Record<string, ReturnType<typeof environment>>;
    landedOn?: string | null;
  } = {},
) {
  const owner = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  await seedProjectDocument(harness.db, project.id, owner.id, {
    environments: opts.environments ?? { staging: environment('qa') },
  });
  await service.putSecret({
    projectId: project.id,
    scope: 'qa',
    name: 'admin',
    value: ADMIN_PASSWORD,
  });
  await service.putSecret({ projectId: project.id, scope: 'qa', name: 'db', value: DB_PASSWORD });
  for (const id of ['qa', 'other', 'dev', 'beta']) {
    const written = await service.writeTestingProfile({
      projectId: project.id,
      profileId: id,
      userId: owner.id,
      baseRevision: null,
      raw: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id,
        actors: { admin: { role: 'project-admin', credential: 'secret://qa/admin' } },
        services: { postgres: { access: 'readonly', credential: 'secret://qa/db' } },
        limits: [],
      },
    });
    expect(written.ok).toBe(true);
  }
  const job = await seedJob(
    project.id,
    owner.id,
    'test',
    opts.landedOn === undefined ? 'main' : opts.landedOn,
  );
  return { owner, project, job };
}

const resolve = (token: string | null, jobId: string, profile: string, query = '') =>
  app.request(`/api/jobs/${jobId}/testing-profiles/${profile}/secrets${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

async function codeOf(res: Response): Promise<string> {
  const body = (await res.json()) as { code?: string; error?: { code?: string } };
  return body.code ?? body.error?.code ?? JSON.stringify(body);
}

describe('GET /api/jobs/:id/testing-profiles/:profile/secrets', () => {
  it('hands the job its own environment profile values, and audits names only', async () => {
    const { job } = await seed();
    const res = await resolve(job.credential, job.jobId, 'qa');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      jobId: job.jobId,
      environment: 'staging',
      profileId: 'qa',
      secrets: [
        { ref: 'secret://qa/admin', value: ADMIN_PASSWORD },
        { ref: 'secret://qa/db', value: DB_PASSWORD },
      ],
    });
    const audit = await harness.db.execute<{ data: Record<string, unknown> }>(sql`
      SELECT data FROM job_events WHERE job_id = ${job.jobId} AND kind = 'secret_resolve'
    `);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({
      environment: 'staging',
      profile: 'qa',
      refs: ['secret://qa/admin', 'secret://qa/db'],
    });
    expect(JSON.stringify(audit[0]?.data)).not.toContain(ADMIN_PASSWORD);
  });

  it('answers `self` as the job the credential runs, and narrows to the refs asked for', async () => {
    const { job } = await seed();
    const res = await resolve(job.credential, 'self', 'qa', '?ref=secret://qa/db');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string; secrets: unknown[] };
    expect(body.jobId).toBe(job.jobId);
    expect(body.secrets).toEqual([{ ref: 'secret://qa/db', value: DB_PASSWORD }]);
  });

  it('refuses a personal access token, which names no job', async () => {
    const { owner, project, job } = await seed();
    const { plaintext } = await mintPat({
      userId: owner.id,
      name: 'a person token',
      boundProjectId: project.id,
    });
    const res = await resolve(plaintext, job.jobId, 'qa');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('TESTING_SECRETS_NOT_A_JOB_CREDENTIAL');
  });

  it('refuses a browser session, by bearer and by cookie', async () => {
    const { owner, job } = await seed();
    const session = await signUserToken(owner.id);
    const byBearer = await resolve(session, job.jobId, 'qa');
    expect(byBearer.status).toBe(403);
    expect(await codeOf(byBearer)).toBe('TESTING_SECRETS_SESSION_REFUSED');
    const byCookie = await app.request(`/api/jobs/${job.jobId}/testing-profiles/qa/secrets`, {
      headers: { cookie: `forge_auth=${session}` },
    });
    expect([401, 403]).toContain(byCookie.status);
  });

  it("refuses another job's credential asking for this job", async () => {
    const { owner, project, job } = await seed();
    const foreign = await seedJob(project.id, owner.id);
    const res = await resolve(foreign.credential, job.jobId, 'qa');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('TESTING_SECRETS_FOREIGN_JOB');
  });

  it('refuses a profile the environment does not name', async () => {
    const { job } = await seed();
    const res = await resolve(job.credential, job.jobId, 'other');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('TESTING_PROFILE_NOT_NAMED');
  });

  it('refuses a secret the profile does not name', async () => {
    const { job } = await seed();
    const res = await resolve(job.credential, job.jobId, 'qa', '?ref=secret://qa/nope');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('SECRET_NOT_NAMED');
  });

  it('refuses a reference with no stored value, and never answers it empty', async () => {
    const { project, job } = await seed();
    await harness.db.execute(sql`
      DELETE FROM project_secrets WHERE project_id = ${project.id} AND name = 'db'
    `);
    const res = await resolve(job.credential, job.jobId, 'qa');
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain('SECRET_VALUE_MISSING');
    expect(body).toContain('secret://qa/db');
    expect(body).not.toContain(ADMIN_PASSWORD);
    const audit = await harness.db.execute(sql`
      SELECT 1 FROM job_events WHERE job_id = ${job.jobId} AND kind = 'secret_resolve'
    `);
    expect(audit).toHaveLength(0);
  });

  it('refuses a value too short for the scrubber to take back', async () => {
    const { project, job } = await seed();
    await service.putSecret({ projectId: project.id, scope: 'qa', name: 'db', value: 'abc' });
    const res = await resolve(job.credential, job.jobId, 'qa');
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('SECRET_TOO_SHORT_TO_SCRUB');
  });

  it('refuses a job that judges no deployment', async () => {
    const { owner, project } = await seed();
    await harness.db.execute(sql`DELETE FROM jobs`);
    await harness.db.execute(sql`DELETE FROM agent_sessions`);
    const code = await seedJob(project.id, owner.id, 'code');
    const res = await resolve(code.credential, code.jobId, 'qa');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('TESTING_SECRETS_JOB_NOT_JUDGING');
  });

  it('scrubs a resolved value out of the job output it posts', async () => {
    const { job } = await seed();
    expect((await resolve(job.credential, job.jobId, 'qa')).status).toBe(200);
    const line = `logged in as admin with password ${ADMIN_PASSWORD} against db ${DB_PASSWORD}`;
    const posted = await app.request(`/api/jobs/${job.jobId}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${job.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            kind: 'stdout',
            data: { line: { type: 'assistant', text: line, deep: [[[{ v: line }]]] } },
          },
        ],
      }),
    });
    expect(posted.status).toBe(200);
    const rows = await harness.db.execute<{ data: unknown }>(sql`
      SELECT data FROM job_events WHERE job_id = ${job.jobId} AND kind = 'stdout'
    `);
    const stored = JSON.stringify(rows[0]?.data);
    expect(stored).not.toContain(ADMIN_PASSWORD);
    expect(stored).not.toContain(DB_PASSWORD);
    expect(stored).toContain('logged in as admin with password [Filtered]');
  });

  it('scrubs a resolved value out of the session lines its box posts', async () => {
    const { job } = await seed();
    expect((await resolve(job.credential, job.jobId, 'qa')).status).toBe(200);
    const posted = await app.request(`/api/agent-sessions/${job.sessionId}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${job.credential}`,
        'content-type': 'application/json',
        'x-test-device': job.deviceId,
      },
      body: JSON.stringify({
        events: [
          {
            seq: 1,
            kind: 'stdout',
            data: { line: { type: 'assistant', text: `pw=${ADMIN_PASSWORD}` } },
          },
        ],
      }),
    });
    expect(posted.status).toBe(200);
    const rows = await harness.db.execute<{ data: unknown }>(sql`
      SELECT data FROM agent_session_events WHERE agent_session_id = ${job.sessionId}
    `);
    expect(JSON.stringify(rows[0]?.data)).not.toContain(ADMIN_PASSWORD);
  });

  it('refuses a box posting an audit row of its own', async () => {
    const { job } = await seed();
    const posted = await app.request(`/api/jobs/${job.jobId}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${job.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ kind: 'secret_resolve', data: { refs: [] } }] }),
    });
    expect(posted.status).toBe(400);
  });
});

describe('the environment a job judges is the one deploying its landed branch', () => {
  const forgeDev = { dev: environment('dev', 'dev'), beta: environment('beta', 'main') };

  it('judges dev for an issue that landed on dev, and hands out its profile only', async () => {
    const { job } = await seed({ environments: forgeDev, landedOn: 'dev' });
    const res = await resolve(job.credential, 'self', 'dev');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { environment: string }).environment).toBe('dev');
    const other = await resolve(job.credential, 'self', 'beta');
    expect(other.status).toBe(403);
    expect(await codeOf(other)).toBe('TESTING_PROFILE_NOT_NAMED');
  });

  it('judges beta for an issue that landed on main', async () => {
    const { job } = await seed({ environments: forgeDev, landedOn: 'main' });
    const res = await resolve(job.credential, 'self', 'beta');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { environment: string }).environment).toBe('beta');
  });

  it('refuses an issue whose work has not landed', async () => {
    const { job } = await seed({ environments: forgeDev, landedOn: null });
    const res = await resolve(job.credential, 'self', 'dev');
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('TESTING_SECRETS_NOT_LANDED');
  });

  it('refuses a landing no environment deploys from', async () => {
    const { job } = await seed({ environments: forgeDev, landedOn: 'release' });
    const res = await resolve(job.credential, 'self', 'dev');
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('TESTING_SECRETS_NO_ENVIRONMENT_FOR_TARGET');
  });

  it('refuses to pick between two environments that deploy the landed branch', async () => {
    const { job } = await seed({
      environments: { staging: environment('qa'), preview: environment('other') },
    });
    const res = await resolve(job.credential, job.jobId, 'qa');
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('TESTING_SECRETS_ENVIRONMENT_AMBIGUOUS');
  });
});
