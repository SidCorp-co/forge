/**
 * ISS-1190 — a release batch's finish is taken at the door and done by a job,
 * over HTTP, against real Postgres and a running pg-boss.
 *
 * The reproduction was a batch whose verification could not settle inside its window: a finish that
 * awaited its own work held its response for the whole window, which behind the edge is a 524 and a
 * batch that never learns its verdict. Since ISS-1282 the finish judges readings the agent asked
 * Forge to keep and waits on no clock, so the door answers inside a bound that has nothing to do
 * with the roster, refuses a deploy no reading shows live, and the verdict is readable off the batch.
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
/** The door's bound. */
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

async function declareProbe(): Promise<void> {
  await harness.db.execute(sql`
    UPDATE integration_bindings
    SET config = config || ${JSON.stringify({
      verify: { probes: [{ url: probeUrl }], stableReads: 1 },
    })}::jsonb
    WHERE project_id = ${projectId} AND provider = 'coolify'
  `);
}

/** A batch of `n` issues, opened while the probe serves `BEFORE`, with nobody having looked yet. */
async function batch(n: number) {
  await declareProbe();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await fx.insertIssue());
  const { runId } = await fx.claim(ids, { look: false });
  return { runId, ids };
}

/** The deploy lands, and the agent looks: what the finish is judged on. */
async function landed(runId: string, commit = PUSHED): Promise<void> {
  serving = commit;
  await fx.look(runId);
}

/** A batch whose deploy landed and was looked at, so a finish has a reading to close on. */
async function readyBatch(n: number) {
  const opened = await batch(n);
  await landed(opened.runId);
  return opened;
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
  it('refuses a deploy no reading shows live at once, writing no attempt and closing nothing', async () => {
    const { runId, ids } = await batch(1);
    await fx.look(runId);

    const res = await finish(runId, { commit: PUSHED });

    expect(res.status).toBe(409);
    expect(res.ms).toBeLessThan(DOOR_MS);
    expect(res.body.code).toBe('RELEASE_NOT_VERIFIED');
    expect(res.body.message).toBe(
      `the live build is unchanged (${BEFORE}) — the site is healthy and still serving the pre-release commit, and the release pushed ${PUSHED}`,
    );
    expect(await rawFinish(runId)).toBeNull();
    expect((await state(runId)).runStatus).toBe('running');
    expect((await fx.stored(ids[0] as string)).status).toBe('releasing');
  });

  it('answers 202 at `accepted` inside the bound once a reading shows the deploy live', async () => {
    const { runId } = await readyBatch(1);

    const res = await finish(runId, { commit: PUSHED });

    expect(res.status).toBe(202);
    expect(res.ms).toBeLessThan(DOOR_MS);
    expect(res.body.finish?.state).toBe('accepted');
    await until(() => state(runId), settled, 20_000);
  }, 40_000);

  it('answers a roster of twenty inside the same bound as a roster of one', async () => {
    const { runId } = await readyBatch(20);

    const res = await finish(runId, { commit: PUSHED });

    expect(res.status).toBe(202);
    expect(res.ms).toBeLessThan(DOOR_MS);
    await until(() => state(runId), settled, 20_000);
  }, 60_000);
});

describe('the job reaches terminal without the caller', () => {
  it('closes every claimed issue and completes the run once the readings confirm the commit', async () => {
    const { runId, ids } = await readyBatch(2);
    const res = await finish(runId, { commit: PUSHED });
    expect(res.status).toBe(202);

    // The run closes in a write after the finished record, so wait for both.
    const closed = (s: Awaited<ReturnType<typeof state>>) =>
      settled(s) && s.runStatus !== 'running';
    const after = await until(() => state(runId), closed, 20_000);
    expect(after.finish?.state).toBe('finished');
    expect(new Set(after.finish?.closed)).toEqual(new Set(ids));
    expect(after.runStatus).toBe('completed');
    for (const id of ids) expect((await fx.stored(id)).status).toBe('closed');
  }, 40_000);

  // Nobody works the attempt: the door is given an enqueue that wakes no one, so the record stays
  // `accepted` for as long as the case needs it to, which no verify window can be asked to hold.
  it('answers the attempt in flight, refuses a second commit, then answers the finished record', async () => {
    const { runId, ids } = await readyBatch(1);
    const { acceptReleaseBatchFinish, runReleaseBatchFinish } = await import(
      '../../src/release-batch/finish-job.js'
    );
    const taken = await acceptReleaseBatchFinish(
      runId,
      { type: 'user', id: ownerId },
      { commit: PUSHED },
      async () => undefined,
    );

    const again = await finish(runId, { commit: PUSHED });
    const other = await finish(runId, { commit: OTHER });

    expect(again.status).toBe(202);
    expect(again.body.finish?.requestId).toBe(taken.finish.requestId);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('RELEASE_FINISH_IN_FLIGHT');
    expect(other.body.message).toContain(PUSHED);

    await runReleaseBatchFinish(runId);
    const done = await finish(runId, { commit: PUSHED });

    expect(done.status).toBe(200);
    expect(done.body.finish?.requestId).toBe(taken.finish.requestId);
    expect(done.body.finish?.closed).toEqual(ids);
    expect(await closesOf(ids[0] as string)).toBe(1);
  }, 60_000);

  // The latest reading wins: the readings a finish was accepted on are not a licence once the site
  // has since been read serving the old build again, so the attempt ends red and says why.
  it('takes a new attempt after a failed one, and that one can finish the batch', async () => {
    const { runId, ids } = await readyBatch(1);
    const { acceptReleaseBatchFinish, runReleaseBatchFinish } = await import(
      '../../src/release-batch/finish-job.js'
    );
    const first = await acceptReleaseBatchFinish(
      runId,
      { type: 'user', id: ownerId },
      { commit: PUSHED },
      async () => undefined,
    );
    serving = BEFORE;
    await fx.look(runId);
    await runReleaseBatchFinish(runId);

    const failed = await state(runId);
    expect(failed.finish?.state).toBe('failed');
    expect(failed.finish?.refusal).toEqual({
      code: 'RELEASE_NOT_VERIFIED',
      reason: `the live build is unchanged (${BEFORE}) — the site is healthy and still serving the pre-release commit, and the release pushed ${PUSHED}`,
      live: BEFORE,
    });
    expect((await fx.stored(ids[0] as string)).status).toBe('releasing');

    await landed(runId);
    const second = await finish(runId, { commit: PUSHED });

    expect(second.status).toBe(202);
    expect(second.body.finish?.requestId).not.toBe(first.finish.requestId);
    const after = await until(() => state(runId), settled, 20_000);
    expect(after.finish?.state).toBe('finished');
    expect((await fx.stored(ids[0] as string)).status).toBe('closed');
  }, 45_000);
});

describe('a finished batch is not asked about another commit in silence', () => {
  it('refuses a finish naming another commit than the one the batch finished for', async () => {
    const { runId, ids } = await readyBatch(1);
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
    const { runId } = await readyBatch(1);
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
    const { runId } = await batch(1);

    const res = await finish(runId, { commit: 'abc1234' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RELEASE_NOT_VERIFIED');
    expect(res.body.message).toMatch(/^`abc1234` is not a whole commit/);
    expect(await rawFinish(runId)).toBeNull();
  });

  // ISS-1276 — an announcement is no longer among what the database can refuse. One case per run,
  // because an accepted finish opens an attempt that answers the next call, and a second batch on
  // one project is BATCH_IN_FLIGHT.
  it('accepts a run that announced no method', async () => {
    const unannounced = await readyBatch(1);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = metadata - 'method' WHERE id = ${unannounced.runId}
    `);

    expect((await finish(unannounced.runId)).status).toBe(202);
  });

  it('refuses a run with no version, recording nothing', async () => {
    const versionless = await batch(1);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET release_version = NULL WHERE id = ${versionless.runId}
    `);

    expect((await finish(versionless.runId)).body.code).toBe('RELEASE_VERSION_MISSING');
    expect(await rawFinish(versionless.runId)).toBeNull();
  });

  it('refuses an aborted run, recording nothing', async () => {
    const aborted = await batch(1);
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET status = 'cancelled' WHERE id = ${aborted.runId}
    `);

    expect((await finish(aborted.runId)).body.code).toBe('RELEASE_BATCH_ABORTED');
    expect(await rawFinish(aborted.runId)).toBeNull();
  });

  it('refuses a project whose verify became one Forge cannot parse, recording nothing', async () => {
    const { runId } = await batch(1);
    await harness.db.execute(sql`
      UPDATE integration_bindings SET config = config || '{"verify": {"probes": []}}'::jsonb
      WHERE project_id = ${projectId}
    `);

    const res = await finish(runId, { commit: PUSHED });

    expect(res.body.code).toBe('RELEASE_PROBES_UNREADABLE');
    expect(await rawFinish(runId)).toBeNull();
  });
});
