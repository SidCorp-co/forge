// The route layer only: what shape core answers with. The readers themselves
// own their own suites (admissible.test.ts, run-session's e2e) and are stubs here,
// so a change to the RESPONSE — the key a runner decodes, the status code a
// refusal arrives on — fails here and nowhere else.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./load.js', () => ({
  readDeviceLoad: vi.fn(),
  readFleetLoad: vi.fn(),
  readProjectLoad: vi.fn(),
}));

const { devicePoolRoutes } = await import('./pool-routes.js');

const app = new Hono();
app.route('/api/devices', devicePoolRoutes);

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
