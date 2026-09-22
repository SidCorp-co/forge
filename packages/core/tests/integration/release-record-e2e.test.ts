/**
 * ISS-1129 — a release that happened, recorded although no batch could be made.
 *
 * The measured failure: four issues' code was merged and deployed by hand,
 * `/version` moved, the web app answered 200, and not one of the four could
 * leave `awaiting_release`, because the only writer of `viaReleasePath: true`
 * sat behind `createReleaseBatch` and batch creation was refused before it
 * started.
 *
 * Integration and through the real route mount, because every claim here is
 * about what a caller is refused or about a row that moved: the evidence gate
 * is a live HTTP read, the closes go through the real transition writer with
 * the real release-gate rewrite in front of them, and the refusals have to
 * leave the roster exactly where it stood.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

let probe: Server;
let served = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
let probeUrl = '';

/** What production is serving in the happy case, and what a record claims. */
const RELEASED = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';
/** A commit nothing is serving. */
const NEVER_DEPLOYED = 'c0ffee1234567890abcdef1234567890abcdef12';

const ACCOUNT =
  'Merged and deployed by hand through the live Coolify binding, because this project declares no release runner label and no batch could be created.';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const [batch, jwt, err] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);

  probe = createServer((_req, res) => res.end(served));
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
}, 60_000);

afterAll(async () => {
  if (probe) await new Promise<void>((done) => probe.close(() => done()));
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  served = RELEASED;
});

interface World {
  projectId: string;
  userId: string;
  token: string;
}

/**
 * A project that declares a release gate and probes, and NOTHING a batch needs:
 * no release runner label on the binding, and no runner row at all.
 */
async function seed(opts: { probes?: boolean; label?: string } = {}): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  await harness.db.execute(sql`
    UPDATE projects SET base_branch = 'main', release_model = 'publish' WHERE id = ${project.id}
  `);
  const connection = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connection}, 'user', ${user.id}, 'coolify', true)
  `);
  const config: Record<string, unknown> = {};
  if (opts.label) config.releaseRunnerLabel = opts.label;
  if (opts.probes !== false) {
    config.verify = { probes: [{ url: probeUrl }], timeoutSeconds: 5, stableReads: 1 };
  }
  await harness.db.execute(sql`
    INSERT INTO integration_bindings (connection_id, project_id, provider, role, stages, active, config)
    VALUES (${connection}, ${project.id}, 'coolify', 'deploy', ARRAY['live'], true,
            ${JSON.stringify(config)}::jsonb)
  `);
  return { projectId: project.id, userId: user.id, token: await signUserToken(user.id) };
}

let seq = 0;

async function insertIssue(
  w: World,
  over: { status?: string; note?: unknown; merged?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  seq += 1;
  const note = over.note === undefined ? { section: 'Skip', userFacing: '-' } : over.note;
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes,
                        merged_at, merged_commit_sha)
    VALUES (${id}, ${w.projectId}, ${seq}, ${`issue ${seq}`},
            ${over.status ?? 'awaiting_release'}, ${w.userId},
            ${note === null ? null : JSON.stringify(note)}::jsonb,
            ${over.merged === false ? null : sql`now()`},
            ${over.merged === false ? null : RELEASED})
  `);
  return id;
}

async function stored(id: string) {
  const rows = await harness.db.execute(sql`
    SELECT status, merged_at, release_batch_run_id FROM issues WHERE id = ${id}
  `);
  return {
    status: String(rows[0]?.status),
    claim: rows[0]?.release_batch_run_id ?? null,
  };
}

function call(path: string, token: string | null, init: RequestInit = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(path, { ...init, headers });
}

const record = (w: World, body: Record<string, unknown>, token: string | null = w.token) =>
  call(`/api/projects/${w.projectId}/release-records`, token, {
    method: 'POST',
    body: JSON.stringify(body),
  });

const readBack = (w: World, runId: string) =>
  call(`/api/projects/${w.projectId}/release-records/${runId}`, w.token);

const causeOf = async (res: { json: () => Promise<unknown> }) =>
  (await res.json()) as { code?: string; message?: string; details?: unknown };

describe('a release that happened is recorded although no batch could be created', () => {
  it('refuses to create a batch on this project, so the batch path is not the way out', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    const res = await call(`/api/projects/${w.projectId}/release-batches`, w.token, {
      method: 'POST',
      body: JSON.stringify({ issueIds: [a] }),
    });

    expect(res.status).toBe(409);
    expect((await causeOf(res)).code).toBe('RELEASE_RUNNER_UNDECLARED');
  });

  it('records the release and closes every issue it carried', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w);

    const res = await record(w, { issueIds: [a, b], commit: RELEASED, account: ACCOUNT });

    expect(res.status).toBe(201);
    expect((await stored(a)).status).toBe('closed');
    expect((await stored(b)).status).toBe('closed');
  });

  it('accepts the abbreviation production reports against the full sha claimed', async () => {
    const w = await seed();
    served = RELEASED.slice(0, 9);
    const a = await insertIssue(w);

    const res = await record(w, { issueIds: [a], commit: RELEASED, account: ACCOUNT });

    expect(res.status).toBe(201);
    expect((await stored(a)).status).toBe('closed');
  });

  it('needs no release runner label and no runner row on the project', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    const runners = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM runners WHERE project_id = ${w.projectId}
    `);
    expect(Number(runners[0]?.n)).toBe(0);
    expect((await record(w, { issueIds: [a], commit: RELEASED, account: ACCOUNT })).status).toBe(
      201,
    );
  });

  it('leaves no claim behind, so a later batch is not wedged out of the issue', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    await record(w, { issueIds: [a], commit: RELEASED, account: ACCOUNT });

    expect((await stored(a)).claim).toBeNull();
  });

  it('enqueues no release_batch job', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    await record(w, { issueIds: [a], commit: RELEASED, account: ACCOUNT });

    const jobs = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM jobs WHERE project_id = ${w.projectId}
    `);
    expect(Number(jobs[0]?.n)).toBe(0);
  });

  it('leaves the account, the commit and the deployment identity on each issue', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    await record(w, {
      issueIds: [a],
      commit: RELEASED,
      account: ACCOUNT,
      providerRef: 'eow4ck00cgww8c4gc08ks0k4',
    });

    const rows = await harness.db.execute(sql`
      SELECT body FROM comments WHERE issue_id = ${a} ORDER BY created_at
    `);
    const body = rows.map((r) => String(r.body)).join('\n');
    expect(body).toContain(RELEASED);
    expect(body).toContain(ACCOUNT);
    expect(body).toContain('eow4ck00cgww8c4gc08ks0k4');
  });

  it('reads the record back with its evidence and the issues it closed', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const created = (await (
      await record(w, { issueIds: [a], commit: RELEASED, account: ACCOUNT })
    ).json()) as { runId: string };

    const body = (await (await readBack(w, created.runId)).json()) as {
      commit: string;
      identity: string;
      account: string;
      readings: string[];
      issues: Array<{ id: string; mergedAt: string | null; mergedCommitSha: string | null }>;
    };

    expect(body.commit).toBe(RELEASED);
    expect(body.identity).toBe(RELEASED);
    expect(body.account).toBe(ACCOUNT);
    expect(body.readings.length).toBe(1);
    expect(body.issues).toEqual([
      { id: a, mergedAt: expect.any(String), mergedCommitSha: RELEASED },
    ]);
  });

  it('answers nothing for a release-batch run, so how it shipped stays answerable', async () => {
    const w = await seed();
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
      VALUES (${runId}, ${w.projectId}, 'system', 'running',
              ${JSON.stringify({ source: 'release-batch' })}::jsonb)
    `);

    expect((await readBack(w, runId)).status).toBe(404);
  });

  it('is behind the same authentication as every other release route', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    const res = await record(w, { issueIds: [a], commit: RELEASED, account: ACCOUNT }, null);

    expect(res.status).toBe(401);
    expect((await stored(a)).status).toBe('awaiting_release');
  });
});

describe('a release that did not happen is refused by name', () => {
  it('refuses a commit the probes are not serving, naming both', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    const res = await record(w, { issueIds: [a], commit: NEVER_DEPLOYED, account: ACCOUNT });

    expect(res.status).toBe(409);
    const cause = await causeOf(res);
    expect(cause.code).toBe('RELEASE_NOT_VERIFIED');
    expect(cause.message).toContain(RELEASED);
    expect(cause.message).toContain(NEVER_DEPLOYED);
  });

  it('leaves every issue at the gate when the commit is not live', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w);

    await record(w, { issueIds: [a, b], commit: NEVER_DEPLOYED, account: ACCOUNT });

    expect(await stored(a)).toEqual({ status: 'awaiting_release', claim: null });
    expect(await stored(b)).toEqual({ status: 'awaiting_release', claim: null });
  });

  // ISS-1161 — measured 2026-09-21. A record written to be refused claimed `6D3F607`,
  // which was a seven-digit prefix of what the deployment was serving, so it verified and
  // closed an issue on a project nobody was working. Through the real route, because the
  // damage was the close and not the comparison.
  it('refuses a seven-character prefix of the commit the probes report', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    const res = await record(w, {
      issueIds: [a],
      commit: RELEASED.slice(0, 7).toUpperCase(),
      account: ACCOUNT,
    });

    expect(res.status).toBe(409);
    const cause = await causeOf(res);
    expect(cause.code).toBe('RELEASE_NOT_VERIFIED');
    expect(cause.message).toContain('is not a whole commit');
    expect(cause.message).toContain(RELEASED);
  });

  it('leaves the issues a prefix claim named exactly where they stood', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w);

    await record(w, {
      issueIds: [a, b],
      commit: RELEASED.slice(0, 7).toUpperCase(),
      account: ACCOUNT,
    });

    expect(await stored(a)).toEqual({ status: 'awaiting_release', claim: null });
    expect(await stored(b)).toEqual({ status: 'awaiting_release', claim: null });
  });

  it('refuses an empty commit at the route, before any release work begins', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    const res = await record(w, { issueIds: [a], commit: '   ', account: ACCOUNT });

    expect(res.status).toBe(400);
    expect((await stored(a)).status).toBe('awaiting_release');
  });

  it('refuses a body carrying no commit at all', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    const res = await record(w, { issueIds: [a], account: ACCOUNT });

    expect(res.status).toBe(400);
    expect((await stored(a)).status).toBe('awaiting_release');
  });

  it('refuses a project that declares no probes, naming RELEASE_PROBES_UNDECLARED', async () => {
    const w = await seed({ probes: false });
    const a = await insertIssue(w);

    const res = await record(w, { issueIds: [a], commit: RELEASED, account: ACCOUNT });

    expect(res.status).toBe(409);
    expect((await causeOf(res)).code).toBe('RELEASE_PROBES_UNDECLARED');
  });

  it('leaves every issue at the gate when the project declares no probes', async () => {
    const w = await seed({ probes: false });
    const a = await insertIssue(w);

    await record(w, { issueIds: [a], commit: RELEASED, account: ACCOUNT });

    expect(await stored(a)).toEqual({ status: 'awaiting_release', claim: null });
  });

  it('refuses an issue that is not at the release gate, naming CLAIM_CONFLICT', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w, { status: 'in_progress' });

    const res = await record(w, { issueIds: [a, b], commit: RELEASED, account: ACCOUNT });

    expect(res.status).toBe(409);
    expect((await causeOf(res)).code).toBe('CLAIM_CONFLICT');
  });

  it('closes nothing when one named issue is not at the release gate', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w, { status: 'in_progress' });

    await record(w, { issueIds: [a, b], commit: RELEASED, account: ACCOUNT });

    expect(await stored(a)).toEqual({ status: 'awaiting_release', claim: null });
    expect((await stored(b)).status).toBe('in_progress');
  });

  it('refuses an issue with no release note, naming RELEASE_RECORD_MISSING', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w, { note: null });

    const res = await record(w, { issueIds: [a, b], commit: RELEASED, account: ACCOUNT });

    expect(res.status).toBe(409);
    expect((await causeOf(res)).code).toBe('RELEASE_RECORD_MISSING');
  });

  it('closes nothing when one named issue has no release note', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w, { note: null });

    await record(w, { issueIds: [a, b], commit: RELEASED, account: ACCOUNT });

    expect(await stored(a)).toEqual({ status: 'awaiting_release', claim: null });
    expect(await stored(b)).toEqual({ status: 'awaiting_release', claim: null });
  });

  it('refuses an issue Forge never watched land, naming it', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w, { merged: false });

    const res = await record(w, { issueIds: [a, b], commit: RELEASED, account: ACCOUNT });

    expect(res.status).toBe(409);
    const cause = await causeOf(res);
    expect(cause.code).toBe('RELEASE_WORK_UNMERGED');
    expect(cause.details).toEqual({ issueIds: [b] });
  });

  it('closes nothing when one named issue was never merged', async () => {
    const w = await seed();
    const a = await insertIssue(w);
    const b = await insertIssue(w, { merged: false });

    await record(w, { issueIds: [a, b], commit: RELEASED, account: ACCOUNT });

    expect(await stored(a)).toEqual({ status: 'awaiting_release', claim: null });
    expect(await stored(b)).toEqual({ status: 'awaiting_release', claim: null });
  });

  it('refuses an account too short to say how the release was performed', async () => {
    const w = await seed();
    const a = await insertIssue(w);

    const res = await record(w, { issueIds: [a], commit: RELEASED, account: 'ok' });

    expect(res.status).toBe(400);
    expect((await stored(a)).status).toBe('awaiting_release');
  });
});
