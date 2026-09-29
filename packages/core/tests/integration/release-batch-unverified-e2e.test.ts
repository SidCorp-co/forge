/**
 * ISS-1321 — a project that declares no verify probe releases, and every door says the release
 * was not verified. A `verify` Forge cannot parse is still refused, and takes no project default.
 */

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

const RELEASED = 'b853f813d0e4b2a1c9f8e7d6c5b4a39281706f5e';
const ACCOUNT =
  'Deployed by hand through the provider console, which reports no commit Forge could read.';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let jwt: string;

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
  server = await startTestServer();
  const { registerReleaseBatchFinish } = await import('../../src/release-batch/finish-job.js');
  await registerReleaseBatchFinish();
}, 120_000);

afterAll(async () => {
  const { resetReleaseBatchFinishForTest } = await import('../../src/release-batch/finish-job.js');
  resetReleaseBatchFinishForTest();
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
  await fx.seedReleaseRunner();
});

type Body = Record<string, unknown> & {
  code?: string;
  details?: Record<string, unknown>;
  finish?: { state: string; verification?: string | null; closed?: string[] | null };
};

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

async function runMetadata(runId: string): Promise<Record<string, unknown>> {
  const rows = await harness.db.execute(
    sql`SELECT metadata FROM pipeline_runs WHERE id = ${runId}`,
  );
  return (rows[0]?.metadata ?? {}) as Record<string, unknown>;
}

async function markedComments(issueId: string, runId: string): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM comments
    WHERE issue_id = ${issueId}
      AND body LIKE ${`%release-verification: unverified ${runId}%`}
  `);
  return Number(rows[0]?.n ?? 0);
}

async function finished(runId: string): Promise<Body['finish']> {
  for (let i = 0; i < 120; i += 1) {
    const { body } = await call('GET', `/release-batches/${runId}/state`);
    const state = body.finish?.state;
    if (state === 'finished' || state === 'failed') return body.finish;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the finish never settled');
}

async function breakVerify(): Promise<void> {
  await harness.db.execute(sql`
    UPDATE integration_bindings SET config = config || '{"verify": {"probes": []}}'::jsonb
    WHERE project_id = ${projectId} AND provider = 'coolify'
  `);
}

describe('a project with no verify probe releases unverified', () => {
  beforeEach(async () => {
    await fx.declareProduction({ verify: null });
  });

  it('opens the batch, claims the roster, and says the release is unverified', async () => {
    const a = await fx.insertIssue();

    const res = await call('POST', '/release-batches', { issueIds: [a] });

    expect(res.status).toBe(201);
    expect(res.body.verification).toBe('unverified');
    expect((await fx.stored(a)).status).toBe('releasing');
    expect((await runMetadata(String(res.body.runId))).verification).toBe('unverified');
  });

  it('answers GET /deployment with what it knows instead of refusing', async () => {
    const res = await call('GET', '/deployment');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      verified: false,
      identity: null,
      health: 'unknown',
      readings: [],
      verifySource: 'none',
    });
  });

  it('finishes a claimless finish, closing the roster with one unverified note each', async () => {
    const a = await fx.insertIssue();
    const b = await fx.insertIssue();
    const { runId } = await fx.claim([a, b]);

    const res = await call('POST', `/release-batches/${runId}/finish`, {});
    expect(res.status).toBe(202);

    const settled = await finished(runId);
    expect(settled).toMatchObject({ state: 'finished', verification: 'unverified' });
    expect((await fx.stored(a)).status).toBe('closed');
    expect((await fx.stored(b)).status).toBe('closed');
    expect(await markedComments(a, runId)).toBe(1);
    expect(await markedComments(b, runId)).toBe(1);
    // The run closes in a write after the finished record, so wait for it.
    await fx.waitFor(async () => (await fx.runStatus(runId)) !== 'running');
    expect(await fx.runStatus(runId)).toBe('completed');
  }, 40_000);

  it('settles an attempt account as unverified rather than failed', async () => {
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);
    const opened = await call('POST', `/release-batches/${runId}/attempts`, {
      stage: 'deploy',
      idempotencyKey: 'deploy-1',
    });
    expect(opened.status).toBeLessThan(300);

    const settled = await call('POST', `/release-batches/${runId}/attempts/deploy-1/account`, {
      account: 'Deployed through the provider console.',
    });

    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ verdict: 'unverified', health: null });
  });

  it('records a release performed by hand, unverified in the ledger and on the issue', async () => {
    const a = await fx.insertIssue();

    const res = await call('POST', '/release-records', {
      issueIds: [a],
      commit: RELEASED,
      account: ACCOUNT,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ identity: null, verification: 'unverified', closed: [a] });
    const ledger = await harness.db.execute(sql`
      SELECT verdict, health FROM release_attempts WHERE run_id = ${String(res.body.runId)}
    `);
    expect(ledger[0]).toMatchObject({ verdict: 'unverified', health: null });
    const notes = await harness.db.execute(sql`
      SELECT body FROM comments WHERE issue_id = ${a} AND body LIKE '%not verified%'
    `);
    expect(notes.length).toBe(1);
    expect((await fx.stored(a)).status).toBe('closed');
  });
});

describe('the unverified note, once per issue per release run', () => {
  it('writes none twice for one run, and one more for a second run', async () => {
    const a = await fx.insertIssue();
    const { noteUnverifiedCloses } = await import('../../src/release-batch/unverified-close.js');
    const [first, second] = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    const actor = { type: 'user', id: ownerId } as const;

    const written = [
      await noteUnverifiedCloses({ runId: first, issueIds: [a], actor, commit: RELEASED }),
      await noteUnverifiedCloses({ runId: first, issueIds: [a], actor, commit: RELEASED }),
      await noteUnverifiedCloses({ runId: second, issueIds: [a], actor, commit: null }),
    ];

    expect(written).toEqual([1, 0, 1]);
    expect(await markedComments(a, first)).toBe(1);
    expect(await markedComments(a, second)).toBe(1);
  });

  it('writes one note when two workers of one run reach the same issue at once', async () => {
    const a = await fx.insertIssue();
    const { noteUnverifiedCloses } = await import('../../src/release-batch/unverified-close.js');
    const runId = '33333333-3333-4333-8333-333333333333';
    const actor = { type: 'user', id: ownerId } as const;
    const pass = () => noteUnverifiedCloses({ runId, issueIds: [a], actor, commit: null });

    const written = await Promise.all([pass(), pass(), pass()]);

    expect(written.reduce((n, w) => n + w, 0)).toBe(1);
    expect(await markedComments(a, runId)).toBe(1);
  });
});

describe('a verify Forge cannot parse is still refused, by name', () => {
  beforeEach(async () => {
    await fx.declareProduction({ verify: { probes: [] } });
    // A project default that must NOT stand in for the refused declaration.
    await harness.db.execute(sql`
      UPDATE projects SET environments = ${JSON.stringify({
        live: { url: 'https://app.example.test', commitUrl: 'https://app.example.test/version' },
      })}::jsonb WHERE id = ${projectId}
    `);
  });

  it('refuses the create door, naming the binding, and claims nothing', async () => {
    const a = await fx.insertIssue();

    const res = await call('POST', '/release-batches', { issueIds: [a] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RELEASE_PROBES_UNREADABLE');
    expect((res.body.details?.bindings as unknown[] | undefined)?.length).toBe(1);
    expect(await fx.stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  it('refuses the record door', async () => {
    const a = await fx.insertIssue();

    const res = await call('POST', '/release-records', {
      issueIds: [a],
      commit: RELEASED,
      account: ACCOUNT,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RELEASE_PROBES_UNREADABLE');
    expect((await fx.stored(a)).status).toBe('awaiting_release');
  });

  it('refuses GET /deployment', async () => {
    const res = await call('GET', '/deployment');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROBES_UNREADABLE');
  });
});

describe('a batch whose probes changed after it opened', () => {
  it('records the close as it was proved, on the finish and on the run alike', async () => {
    await fx.declareProduction();
    const a = await fx.insertIssue();
    const { runId, verification } = await fx.claim([a]);
    expect(verification).toBe('probed');
    await harness.db.execute(sql`
      UPDATE integration_bindings SET config = config - 'verify' WHERE project_id = ${projectId}
    `);

    await call('POST', `/release-batches/${runId}/finish`, {});
    const settled = await finished(runId);

    expect(settled).toMatchObject({ state: 'finished', verification: 'unverified' });
    expect((await runMetadata(runId)).verification).toBe('unverified');
    expect(await markedComments(a, runId)).toBe(1);
  }, 40_000);

  it('refuses a probe url that is not a url by name, before any close', async () => {
    await fx.declareProduction();
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);
    await harness.db.execute(sql`
      UPDATE integration_bindings
      SET config = config || '{"verify": {"probes": [{"url": "api/version"}]}}'::jsonb
      WHERE project_id = ${projectId}
    `);

    const res = await call('POST', `/release-batches/${runId}/finish`, { commit: RELEASED });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RELEASE_PROBES_UNREADABLE');
    expect(res.body.details).toMatchObject({ urls: ['api/version'] });
    expect((await fx.stored(a)).status).toBe('releasing');
  });
});

describe('a batch whose verify became unparseable after it opened', () => {
  it('refuses the finish by name and closes nothing', async () => {
    await fx.declareProduction();
    const a = await fx.insertIssue();
    const { runId } = await fx.claim([a]);
    await breakVerify();

    const res = await call('POST', `/release-batches/${runId}/finish`, { commit: RELEASED });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RELEASE_PROBES_UNREADABLE');
    expect((await fx.stored(a)).status).toBe('releasing');
    expect(await fx.runStatus(runId)).toBe('running');
  });
});
