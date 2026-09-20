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
const readRunSessionTerminal = vi.fn(async (_args: unknown) => null as boolean | null);

vi.mock('./pool.js', () => ({ readPool: (a: unknown) => readPool(a) }));
vi.mock('./admissible.js', () => ({
  readAdmissibleIssues: (a: unknown) => readAdmissibleIssues(a),
}));
type LeaseHolder = {
  issueKey: string;
  deviceId: string;
  sessionId: string;
  runId: string;
  acquiredAt: string;
};
const readDeviceIssueLease = vi.fn(
  async (_args: unknown) =>
    ({ held: false, heldByThisDevice: false, holder: null }) as {
      held: boolean;
      heldByThisDevice: boolean;
      holder: LeaseHolder | null;
    },
);
vi.mock('../issues/issue-lease.js', () => ({
  readDeviceIssueLease: (a: unknown) => readDeviceIssueLease(a),
}));
vi.mock('./run-session.js', () => ({
  openRunSession: (a: unknown) => openRunSession(a),
  closeRunSession: vi.fn(),
  readRunSessionTerminal: (a: unknown) => readRunSessionTerminal(a),
  isIssueLeaseHeld: vi.fn(),
  releaseIssueLease: vi.fn(),
}));
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
app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);

const AUTH = { Authorization: 'Bearer good' };
const ISSUE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  readPool.mockReset().mockResolvedValue([]);
  readAdmissibleIssues.mockReset().mockResolvedValue([]);
  openRunSession.mockReset();
  readRunSessionTerminal.mockReset().mockResolvedValue(null);
});

describe('GET /me/pool', () => {
  it('keeps items and count exactly as they were', async () => {
    readPool.mockResolvedValue([{ jobId: 'j1' }]);
    const res = await app.request('/api/devices/me/pool', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.items).toEqual([{ jobId: 'j1' }]);
    expect(body.count).toBe(1);
  });

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

describe('GET /me/run-sessions/:sessionId — core reads a run session back over the device API', () => {
  const SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const path = `/api/devices/me/run-sessions/${SESSION}`;

  it('answers the session core holds for this device', async () => {
    readRunSessionTerminal.mockResolvedValue(false);
    const res = await app.request(path, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionTerminal: false });
  });

  it('carries the terminal mark core holds rather than a fixed answer', async () => {
    readRunSessionTerminal.mockResolvedValue(true);
    const res = await app.request(path, { headers: AUTH });
    expect(await res.json()).toEqual({ sessionTerminal: true });
  });

  it('scopes the read to the calling device and to the session in the path', async () => {
    readRunSessionTerminal.mockResolvedValue(false);
    await app.request(path, { headers: AUTH });
    expect(readRunSessionTerminal).toHaveBeenCalledWith({ deviceId: 'dev-1', sessionId: SESSION });
  });

  it('answers 404 for a session this device does not hold', async () => {
    readRunSessionTerminal.mockResolvedValue(null);
    const res = await app.request(path, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('refuses a caller with no device credential', async () => {
    const res = await app.request(path);
    expect(res.status).toBe(401);
  });
});

/**
 * ISS-1109 — the lease read answers two questions, and says which is which.
 *
 * The two answers stay apart: a box asking about an issue another box is
 * running must not be told `false` and open its own run over it.
 */
describe('GET /me/issue-leases/:issueKey', () => {
  const path = '/api/devices/me/issue-leases/ISS-357';

  it('carries the fleet answer and this box answer separately', async () => {
    readDeviceIssueLease.mockResolvedValue({
      held: true,
      heldByThisDevice: false,
      holder: null,
    });

    const res = await app.request(path, { headers: AUTH });

    expect(await res.json()).toMatchObject({ held: true, heldByThisDevice: false });
  });

  it('names the holder so a refused box knows which one to ask', async () => {
    readDeviceIssueLease.mockResolvedValue({
      held: true,
      heldByThisDevice: false,
      holder: {
        issueKey: 'ISS-357',
        deviceId: 'dev-9',
        sessionId: 'sess-9',
        runId: 'run-9',
        acquiredAt: '2026-09-20T09:37:00.000Z',
      },
    });

    const res = await app.request(path, { headers: AUTH });

    const body = (await res.json()) as { holder: LeaseHolder | null };
    expect(body.holder).toMatchObject({
      deviceId: 'dev-9',
      acquiredAt: '2026-09-20T09:37:00.000Z',
    });
  });

  it('answers a free issue with no holder at all', async () => {
    readDeviceIssueLease.mockResolvedValue({
      held: false,
      heldByThisDevice: false,
      holder: null,
    });

    const res = await app.request(path, { headers: AUTH });

    expect(await res.json()).toEqual({ held: false, heldByThisDevice: false, holder: null });
  });

  it('asks on behalf of the calling device and the key in the path', async () => {
    readDeviceIssueLease.mockResolvedValue({
      held: false,
      heldByThisDevice: false,
      holder: null,
    });

    await app.request(path, { headers: AUTH });

    expect(readDeviceIssueLease).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      issueKey: 'ISS-357',
    });
  });

  it('refuses a caller with no device credential', async () => {
    const res = await app.request(path);
    expect(res.status).toBe(401);
  });
});
