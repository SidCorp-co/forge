/**
 * ISS-1190 — a release batch's finish is taken at the door and done by a job,
 * over HTTP, against real Postgres and a running pg-boss.
 *
 * The reproduction is a batch whose verification cannot settle inside its
 * window: a finish that awaits its own work holds its response for the whole
 * window, which behind the edge is a 524 and a batch that never learns its
 * verdict. The door must answer inside a bound that has nothing to do with the
 * window or the roster, and the verdict must be readable off the batch.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

const BEFORE = '1111111111111111111111111111111111111111';
const PUSHED = '2222222222222222222222222222222222222222';
const OTHER = '3333333333333333333333333333333333333333';
/** The door's bound. The verify windows below are four and more times it. */
const DOOR_MS = 2_000;

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let jwt: string;
let serving = BEFORE;
let probe: Server;
let probeUrl: string;

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  probe = createServer((_req, res) => res.end(serving));
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/version`;
  server = await startTestServer();
  const { registerReleaseBatchFinish } = await import('../../src/release-batch/finish-job.js');
  await registerReleaseBatchFinish();
}, 120_000);

afterAll(async () => {
  const { resetReleaseBatchFinishForTest } = await import('../../src/release-batch/finish-job.js');
  resetReleaseBatchFinishForTest();
  await server?.close();
  await new Promise<void>((done) => probe.close(() => done()));
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  serving = BEFORE;
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
  await fx.declareProduction();
  await fx.seedReleaseRunner();
});

async function window(timeoutSeconds: number): Promise<void> {
  await harness.db.execute(sql`
    UPDATE integration_bindings
    SET config = config || ${JSON.stringify({
      verify: { probes: [{ url: probeUrl }], timeoutSeconds, stableReads: 1 },
    })}::jsonb
    WHERE project_id = ${projectId} AND provider = 'coolify'
  `);
}

/** A batch of `n` issues, opened while the probe serves `BEFORE`. */
async function batch(n: number, seconds: number) {
  await window(seconds);
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await fx.insertIssue());
  const { runId } = await fx.claim(ids);
  return { runId, ids };
}

interface FinishBody {
  runId?: string;
  finish?: {
    requestId: string;
    state: string;
    commit: string | null;
    closed: string[] | null;
    refusal: { code: string; reason: string; live: string | null } | null;
  };
  code?: string;
  message?: string;
}

async function finish(runId: string, body: Record<string, unknown> = {}) {
  const started = Date.now();
  const res = await fetch(
    `${server.baseUrl}/api/projects/${projectId}/release-batches/${runId}/finish`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, ms: Date.now() - started, body: (await res.json()) as FinishBody };
}

async function state(runId: string) {
  const res = await fetch(
    `${server.baseUrl}/api/projects/${projectId}/release-batches/${runId}/state`,
    { headers: { authorization: `Bearer ${jwt}` } },
  );
  return (await res.json()) as { runStatus: string; finish: FinishBody['finish'] | null };
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const settled = (s: { finish: FinishBody['finish'] | null }) =>
  s.finish?.state === 'finished' || s.finish?.state === 'failed';

async function rawFinish(runId: string): Promise<unknown> {
  const rows = await harness.db.execute(sql`
    SELECT metadata -> 'finish' AS finish FROM pipeline_runs WHERE id = ${runId}
  `);
  return rows[0]?.finish ?? null;
}

async function closesOf(issueId: string): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM kernel_transitions
    WHERE entity = 'issue' AND entity_id = ${issueId} AND to_status = 'closed'
  `);
  return Number(rows[0]?.n ?? 0);
}

describe('the door answers inside its own bound (the reproduction)', () => {
  it('answers 202 at `accepted` while a verify window that cannot settle is still open', async () => {
    const { runId } = await batch(1, 8);

    const res = await finish(runId, { commit: PUSHED });

    expect(res.status).toBe(202);
    expect(res.ms).toBeLessThan(DOOR_MS);
    expect(res.body.finish?.state).toBe('accepted');

    const after = await until(() => state(runId), settled, 20_000);
    expect(after.finish?.state).toBe('failed');
    expect(after.finish?.refusal).toEqual({
      code: 'RELEASE_NOT_VERIFIED',
      reason: `the live build is unchanged (${BEFORE}) — the site is healthy and still serving the pre-release commit, and the release pushed ${PUSHED}`,
      live: BEFORE,
    });
    expect(after.runStatus).toBe('running');
  }, 40_000);

  it('answers a roster of twenty inside the same bound as a roster of one', async () => {
    const { runId } = await batch(20, 8);

    const res = await finish(runId, { commit: PUSHED });

    expect(res.status).toBe(202);
    expect(res.ms).toBeLessThan(DOOR_MS);
    await until(() => state(runId), settled, 20_000);
  }, 60_000);
});

describe('the job reaches terminal without the caller', () => {
  it('closes every claimed issue and completes the run once the probes confirm the commit', async () => {
    const { runId, ids } = await batch(2, 20);
    serving = PUSHED;

    const res = await finish(runId, { commit: PUSHED });
    expect(res.status).toBe(202);

    const after = await until(() => state(runId), settled, 20_000);
    expect(after.finish?.state).toBe('finished');
    expect(new Set(after.finish?.closed)).toEqual(new Set(ids));
    expect(after.runStatus).toBe('completed');
    for (const id of ids) expect((await fx.stored(id)).status).toBe('closed');
  }, 40_000);

  it('answers the attempt in flight, refuses a second commit, then answers the finished record', async () => {
    const { runId, ids } = await batch(1, 20);

    const first = await finish(runId, { commit: PUSHED });
    const again = await finish(runId, { commit: PUSHED });
    const other = await finish(runId, { commit: OTHER });

    expect(again.status).toBe(202);
    expect(again.body.finish?.requestId).toBe(first.body.finish?.requestId);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('RELEASE_FINISH_IN_FLIGHT');
    expect(other.body.message).toContain(PUSHED);

    serving = PUSHED;
    await until(() => state(runId), settled, 25_000);
    const done = await finish(runId, { commit: PUSHED });

    expect(done.status).toBe(200);
    expect(done.body.finish?.requestId).toBe(first.body.finish?.requestId);
    expect(done.body.finish?.closed).toEqual(ids);
    expect(await closesOf(ids[0] as string)).toBe(1);
  }, 60_000);

  it('takes a new attempt after a failed one, and that one can finish the batch', async () => {
    const { runId, ids } = await batch(1, 2);
    const first = await finish(runId, { commit: PUSHED });
    const failed = await until(() => state(runId), settled, 15_000);
    expect(failed.finish?.state).toBe('failed');

    serving = PUSHED;
    const second = await finish(runId, { commit: PUSHED });

    expect(second.status).toBe(202);
    expect(second.body.finish?.requestId).not.toBe(first.body.finish?.requestId);
    const after = await until(() => state(runId), settled, 20_000);
    expect(after.finish?.state).toBe('finished');
    expect((await fx.stored(ids[0] as string)).status).toBe('closed');
  }, 45_000);
});

describe('a finished batch is not asked about another commit in silence', () => {
  it('refuses a finish naming another commit than the one the batch finished for', async () => {
    const { runId, ids } = await batch(1, 20);
    serving = PUSHED;
    await finish(runId, { commit: PUSHED });
    const done = await until(() => state(runId), settled, 20_000);
    expect(done.finish?.state).toBe('finished');
    const recorded = await rawFinish(runId);

    const other = await finish(runId, { commit: OTHER });

    expect(other.status).toBe(409);
    expect(other.body.code).toBe('RELEASE_FINISHED_FOR_OTHER_COMMIT');
    expect(other.body.message).toContain(`already finished for ${PUSHED}`);
    expect(other.body.message).toContain(`this call names ${OTHER}`);
    expect(await rawFinish(runId)).toEqual(recorded);
    expect(await closesOf(ids[0] as string)).toBe(1);

    const claimless = await finish(runId);
    expect(claimless.status).toBe(200);
    expect(claimless.body.finish?.commit).toBe(PUSHED);
  }, 45_000);

  it('refuses a finish naming a commit on a batch that finished with none named', async () => {
    const { runId } = await batch(1, 20);
    serving = PUSHED;
    await finish(runId);
    const done = await until(() => state(runId), settled, 20_000);
    expect(done.finish?.state).toBe('finished');
    expect(done.finish?.commit).toBeNull();

    const named = await finish(runId, { commit: PUSHED });

    expect(named.status).toBe(409);
    expect(named.body.code).toBe('RELEASE_FINISHED_FOR_OTHER_COMMIT');
    expect(named.body.message).toContain('already finished with no named commit');
  }, 45_000);
});

describe('the door refuses what the database can refuse, and records nothing', () => {
  it('refuses a commit that is not a whole sha with the whole-commit sentence', async () => {
    const { runId } = await batch(1, 20);

    const res = await finish(runId, { commit: 'abc1234' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RELEASE_NOT_VERIFIED');
    expect(res.body.message).toMatch(/^`abc1234` is not a whole commit/);
    expect(await rawFinish(runId)).toBeNull();
  });

  it('refuses a run that announced no method, an aborted run and a run with no version', async () => {
    const unannounced = await batch(1, 20);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata - 'method' WHERE id = ${unannounced.runId}
    `);
    expect((await finish(unannounced.runId)).body.code).toBe('RELEASE_METHOD_NOT_ANNOUNCED');
    expect(await rawFinish(unannounced.runId)).toBeNull();

    await harness.db.execute(sql`
      UPDATE pipeline_runs SET release_version = NULL, metadata = metadata || ${JSON.stringify({
        method: { skill: 'release-flow', loaded: true, detail: null, announcedAt: 'x' },
      })}::jsonb WHERE id = ${unannounced.runId}
    `);
    expect((await finish(unannounced.runId)).body.code).toBe('RELEASE_VERSION_MISSING');
    expect(await rawFinish(unannounced.runId)).toBeNull();

    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'cancelled' WHERE id = ${unannounced.runId}
    `);
    expect((await finish(unannounced.runId)).body.code).toBe('RELEASE_BATCH_ABORTED');
    expect(await rawFinish(unannounced.runId)).toBeNull();
  });

  it('refuses a project that declares no probes', async () => {
    const { runId } = await batch(1, 20);
    await harness.db.execute(sql`
      UPDATE integration_bindings SET config = config - 'verify' WHERE project_id = ${projectId}
    `);

    const res = await finish(runId);

    expect(res.body.code).toBe('RELEASE_PROBES_UNDECLARED');
    expect(await rawFinish(runId)).toBeNull();
  });
});
