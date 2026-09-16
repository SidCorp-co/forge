// The route layer only: what shape core answers with. The readers themselves
// own their own suites (admissible.test.ts, run-session's e2e) and are stubs here,
// so a change to the RESPONSE — the key a runner decodes, the status code a
// refusal arrives on — fails here and nowhere else.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerLimitReasons } from '../db/schema.js';

/** The runner crate's own assets, read as files because the packages do not import each other. */
const RUNNER_ASSETS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../runner/crates/forge-runner-core/assets',
);
const WIRE_FIXTURE = resolve(RUNNER_ASSETS, 'master-limit-wire.json');
const REASONS_FIXTURE = resolve(RUNNER_ASSETS, 'master-limit-reasons.json');

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: 'y'.repeat(32), NODE_ENV: 'test' },
}));

vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: async (t: string) =>
    t === 'good' ? { id: 'dev-1', ownerId: 'u-1', status: 'online' } : null,
}));

const readPool = vi.fn(async (_args: unknown) => [] as unknown[]);
const readAdmissibleIssues = vi.fn(async (_args: unknown) => [] as unknown[]);
const openRunSession = vi.fn(async (_args: unknown) => ({}) as unknown);

vi.mock('./pool.js', () => ({ readPool: (a: unknown) => readPool(a) }));
vi.mock('./admissible.js', () => ({
  readAdmissibleIssues: (a: unknown) => readAdmissibleIssues(a),
}));
vi.mock('./run-session.js', () => ({ openRunSession: (a: unknown) => openRunSession(a) }));
vi.mock('./claim.js', () => ({
  claimJobForMaster: vi.fn(),
  releaseAllHeldBySession: vi.fn(),
  releaseJobFromMaster: vi.fn(),
}));
const recordMasterLimit = vi.fn(async (_d: string, _r: unknown) => ({ runnerId: 'r-1' }));
const clearMasterLimit = vi.fn(async (_d: string) => ({ runnerId: 'r-1' }));
vi.mock('./master-limit.js', () => ({
  recordMasterLimit: (d: string, r: unknown) => recordMasterLimit(d, r),
  clearMasterLimit: (d: string) => clearMasterLimit(d),
}));

vi.mock('./load.js', () => ({
  readDeviceLoad: vi.fn(),
  readFleetLoad: vi.fn(),
  readProjectLoad: vi.fn(),
}));

const { devicePoolRoutes } = await import('./pool-routes.js');

const { errorHandler } = await import('../middleware/error.js');

const app = new Hono();
app.route('/api/devices', devicePoolRoutes);
// cm:why the real `onError` is mounted, not left to Hono's default: every refusal on these routes carries its reason in `cause.code`, and that code is the half a runner branches on. A bare app renders only the prose message, so a test without this asserts the sentence and lets the contract the caller actually reads go unchecked.
app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);

const AUTH = { Authorization: 'Bearer good' };
const ISSUE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  readPool.mockReset().mockResolvedValue([]);
  readAdmissibleIssues.mockReset().mockResolvedValue([]);
  openRunSession.mockReset();
});

describe('GET /me/pool', () => {
  // cm:guard `items` and `count` are what every runner already decoded; ISS-933 removed the sibling `backlog` key rather than changing either.
  it('keeps items and count exactly as they were', async () => {
    readPool.mockResolvedValue([{ jobId: 'j1' }]);
    const res = await app.request('/api/devices/me/pool', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.items).toEqual([{ jobId: 'j1' }]);
    expect(body.count).toBe(1);
  });

  // cm:guard the pool answers JOBS and nothing else since ISS-933: an issue in the array a master claims from is a malformed claim waiting to happen, and `pool claim <issueId>` is a turn spent on a refusal core answers as `not_found`.
  it('carries no issues at all, under any key', async () => {
    readPool.mockResolvedValue([{ jobId: 'j1' }]);
    readAdmissibleIssues.mockResolvedValue([{ issueId: ISSUE, status: 'draft' }]);
    const res = await app.request('/api/devices/me/pool', { headers: AUTH });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ items: [{ jobId: 'j1' }], count: 1 });
    expect(JSON.stringify(body)).not.toContain('draft');
  });

  it('401s without a device token', async () => {
    const res = await app.request('/api/devices/me/pool');
    expect(res.status).toBe(401);
  });
});

describe('GET /me/issues/admissible', () => {
  // cm:guard the ONLY reader of `pipelineConfig.poolBacklog.statuses` after ISS-933 deleted `pool promote`. A change that drops this route owes the config key another reader or owes the key its deletion — a knob that is configurable, savable and dead is the shape this repo refuses.
  it('answers the admissible issues on their own route, scoped to the device', async () => {
    const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    readAdmissibleIssues.mockResolvedValue([{ issueId: ISSUE, status: 'draft' }]);
    const res = await app.request(`/api/devices/me/issues/admissible?projectId=${projectId}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ issueId: ISSUE, status: 'draft' }],
      count: 1,
    });
    expect(readAdmissibleIssues).toHaveBeenCalledWith({ deviceId: 'dev-1', projectId });
  });

  it('401s without a device token', async () => {
    const res = await app.request('/api/devices/me/issues/admissible');
    expect(res.status).toBe(401);
  });
});

describe('POST /me/run-sessions', () => {
  it('opens one run over the whole group and answers the session core minted', async () => {
    openRunSession.mockResolvedValue({ sessionId: 's9', runId: 'r9' });
    const res = await app.request('/api/devices/me/run-sessions', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        issueKeys: ['ISS-957', 'ISS-958'],
        name: 'grp-957-958',
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 's9', runId: 'r9' });
    expect(openRunSession).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      issueKeys: ['ISS-957', 'ISS-958'],
      name: 'grp-957-958',
      boxRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
  });

  // cm:guard the assertion is that the box's own run id REACHES the service, and it is separate
  // from the case above because the schema has demanded this field since the route was written
  // while the handler dropped it: every existing test passed a `runId` and none of them asked
  // what became of it, so a 200 that discarded it was indistinguishable from a 200 that stored it
  // (ISS-1050 criterion 6).
  it('passes the box run id through rather than discarding the field it demands', async () => {
    openRunSession.mockResolvedValue({ sessionId: 's9', runId: 'r9' });
    await app.request('/api/devices/me/run-sessions', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        issueKeys: ['ISS-957'],
        name: 'grp',
      }),
    });
    expect(openRunSession.mock.calls.at(-1)?.[0]).toMatchObject({
      boxRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
  });

  // cm:guard an EMPTY group is refused at the schema. A run with no issues is a worktree nothing will ever close the loop on, and `create_run_group` refuses it on the box too — this is the same refusal one hop earlier, where it costs no ledger row.
  it('400s on an empty issue group — a run carries at least one', async () => {
    const res = await app.request('/api/devices/me/run-sessions', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        issueKeys: [],
        name: 'grp',
      }),
    });
    expect(res.status).toBe(400);
    expect(openRunSession).not.toHaveBeenCalled();
  });

  it('401s without a device token', async () => {
    const res = await app.request('/api/devices/me/run-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        issueKeys: ['ISS-957'],
        name: 'grp',
      }),
    });
    expect(res.status).toBe(401);
    expect(openRunSession).not.toHaveBeenCalled();
  });
});

describe('POST /me/limit', () => {
  beforeEach(() => {
    recordMasterLimit.mockReset().mockResolvedValue({ runnerId: 'r-1' });
    clearMasterLimit.mockReset().mockResolvedValue({ runnerId: 'r-1' });
  });

  it('records a typed verdict and passes the reported reset through', async () => {
    const res = await app.request('/api/devices/me/limit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'usage_limit', resetsInSeconds: 900, detail: 'capped' }),
    });
    expect(res.status).toBe(200);
    expect(recordMasterLimit).toHaveBeenCalledWith('dev-1', {
      reason: 'usage_limit',
      resetsInSeconds: 900,
      detail: 'capped',
    });
  });

  // cm:guard an `auth` limit carries NO reset by design (schema: `rateLimitedUntil` is NULL for it, nothing parseable to wait for), so a report pairing the two is a contract break and must be refused BY NAME rather than silently dropping one half — a stamp that kept the reset would hand an auth-dead box a self-healing window it does not have, which is the shape that let dev1-ai013 take 421 jobs on an expired session.
  it('refuses an auth report that carries a reset, by name', async () => {
    const res = await app.request('/api/devices/me/limit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'auth', resetsInSeconds: 60, detail: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('AUTH_LIMIT_HAS_NO_RESET');
    expect(recordMasterLimit).not.toHaveBeenCalled();
  });

  it('refuses an unknown reason instead of stamping something the gates cannot read', async () => {
    const res = await app.request('/api/devices/me/limit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'tired', detail: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(recordMasterLimit).not.toHaveBeenCalled();
  });

  // cm:guard a report the device owns no runner for is a 404, never a 200 — the master would read a 200 as "core knows I am capped" and stop reporting, so an answer that recorded nothing must not look like one that did.
  it('answers 404 when the device owns no runner to stamp', async () => {
    recordMasterLimit.mockResolvedValue(null as never);
    const res = await app.request('/api/devices/me/limit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'usage_limit', detail: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('clears the window on DELETE, which is the only early exit the master lane has', async () => {
    const res = await app.request('/api/devices/me/limit', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    expect(clearMasterLimit).toHaveBeenCalledWith('dev-1');
  });

  // cm:edge lockstep -> packages/runner/crates/forge-runner-core/assets/master-limit-wire.json — the file read here is the body the Rust producer builds from a captured refusal, asserted byte for byte on that side by `daemon::master_limit::tests::a_captured_refusal_reaches_core_as_the_bytes_both_languages_read`. Reading the artifact rather than retyping it is the point: a field renamed on either side stops matching ONE file, instead of passing two suites and failing on a live box.
  // cm:guard the file is read off disk, NOT imported. The two packages have no build dependency on each other and must not gain one over a test fixture; `relations archmap` walks imports, and an import here would declare a coupling that does not exist at runtime.
  it('takes the body the runner actually sends, read off the file both sides read', async () => {
    const body = readFileSync(WIRE_FIXTURE, 'utf8').trim();
    const res = await app.request('/api/devices/me/limit', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(recordMasterLimit).toHaveBeenCalledWith('dev-1', JSON.parse(body));
  });

  // cm:guard the WHOLE set, in both directions. A reason core stops storing is a report the box sends into a 400 forever; a reason core gains that the runner never sends is a cap a master can see and cannot report. Neither shows up in a test that only checks the reasons it happens to name.
  it('stores exactly the reasons the runner declares it can send', () => {
    const declared = JSON.parse(readFileSync(REASONS_FIXTURE, 'utf8')).reasons as string[];
    expect([...declared].sort()).toEqual([...runnerLimitReasons].sort());
  });

  it.each(JSON.parse(readFileSync(REASONS_FIXTURE, 'utf8')).reasons as string[])(
    'accepts a report carrying the declared reason %s',
    async (reason) => {
      const res = await app.request('/api/devices/me/limit', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ reason, detail: 'x' }),
      });
      expect(res.status).toBe(200);
      expect(recordMasterLimit).toHaveBeenCalledWith('dev-1', {
        reason,
        resetsInSeconds: null,
        detail: 'x',
      });
    },
  );
});

// cm:guard the four run-session paths are asserted HERE, on the parent router, because they are
// SERVED by a module split out of it. The handlers keep their own suites either way; what a split
// can break silently, and what nothing else in this repo reads, is whether the sub-router is still
// mounted and still mounted at the same prefix. A missing mount answers 404 — the same status a
// device gets for another box's session — so without this the regression looks like normal scoping.
describe('the run-session family stays mounted where it was', () => {
  const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const paths: [string, string][] = [
    ['POST', '/api/devices/me/run-sessions'],
    ['POST', `/api/devices/me/run-sessions/${SESSION}/close`],
    ['POST', `/api/devices/me/run-sessions/${SESSION}/held-worktree`],
    ['POST', `/api/devices/me/run-sessions/${SESSION}/resume-choice`],
  ];

  it.each(paths)('%s %s reaches a handler rather than falling through', async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: '{}',
    });
    // An empty body is invalid for every one of the four, so a mounted route refuses it at its
    // validator with 400. A route that is NOT mounted answers 404, which is the thing being ruled
    // out — the assertion is "not 404", so it cannot be satisfied by a handler that fell through.
    expect(res.status).toBe(400);
  });

  it('answers 404 for a run-session path that was never served', async () => {
    const res = await app.request(`/api/devices/me/run-sessions/${SESSION}/not-a-verb`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
