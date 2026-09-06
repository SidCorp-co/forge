// The route layer only: what shape core answers with. The readers themselves
// own their own suites (backlog.test.ts, promote.test.ts) and are stubs here,
// so a change to the RESPONSE — the key a runner decodes, the status code a
// refusal arrives on — fails here and nowhere else.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: 'y'.repeat(32), NODE_ENV: 'test' },
}));

vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: async (t: string) =>
    t === 'good' ? { id: 'dev-1', ownerId: 'u-1', status: 'online' } : null,
}));

const readPool = vi.fn(async (_args: unknown) => [] as unknown[]);
const readBacklog = vi.fn(async (_args: unknown) => [] as unknown[]);
const promoteFromBacklog = vi.fn(async (_args: unknown) => ({}) as unknown);

vi.mock('./pool.js', () => ({ readPool: (a: unknown) => readPool(a) }));
vi.mock('./backlog.js', () => ({ readBacklog: (a: unknown) => readBacklog(a) }));
vi.mock('./promote.js', () => ({ promoteFromBacklog: (a: unknown) => promoteFromBacklog(a) }));
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
  readBacklog.mockReset().mockResolvedValue([]);
  promoteFromBacklog.mockReset();
});

describe('GET /me/pool', () => {
  // cm:guard AC1 — a project with no declared backlog changes nothing here: the `items` array and its `count` are what every runner already decoded, and an empty `backlog` beside them is additive.
  it('keeps items and count exactly as they were', async () => {
    readPool.mockResolvedValue([{ jobId: 'j1' }]);
    const res = await app.request('/api/devices/me/pool', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.items).toEqual([{ jobId: 'j1' }]);
    expect(body.count).toBe(1);
  });

  // cm:guard AC4/B6 — a row with no `jobId` sitting in the array a master claims from is a malformed claim waiting to happen. `backlog` is a SIBLING key and must never be folded into `items`.
  it('answers the backlog as its own top-level key, never inside items', async () => {
    readPool.mockResolvedValue([{ jobId: 'j1' }]);
    readBacklog.mockResolvedValue([{ issueId: ISSUE, status: 'draft' }]);
    const res = await app.request('/api/devices/me/pool', { headers: AUTH });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backlog).toEqual([{ issueId: ISSUE, status: 'draft' }]);
    expect(body.backlogCount).toBe(1);
    expect(body.items).toEqual([{ jobId: 'j1' }]);
    expect(JSON.stringify(body.items)).not.toContain('draft');
  });

  it('scopes the backlog read to the same device and project as the pool read', async () => {
    const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await app.request(`/api/devices/me/pool?projectId=${projectId}`, { headers: AUTH });
    expect(readBacklog).toHaveBeenCalledWith({ deviceId: 'dev-1', projectId });
  });

  it('401s without a device token', async () => {
    const res = await app.request('/api/devices/me/pool');
    expect(res.status).toBe(401);
  });
});

describe('POST /me/pool/promote', () => {
  it('returns the drive job id on success', async () => {
    promoteFromBacklog.mockResolvedValue({
      ok: true,
      jobId: 'j9',
      issueId: ISSUE,
      issueKey: 'ISS-917',
    });
    const res = await app.request('/api/devices/me/pool/promote', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ issueId: ISSUE }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, jobId: 'j9' });
  });

  // cm:guard AC7/B4 — an entry-gated project and a race lost to another master are ordinary outcomes a master handles by choosing differently. Making either an error invites a retry loop against a condition retrying cannot change: `entry_gated` clears only when a human edits the config.
  it.each(['entry_gated', 'not_in_backlog', 'issue_busy', 'not_found', 'backlog_disabled'])(
    'answers 200 with ok:false for the refusal %s',
    async (reason) => {
      promoteFromBacklog.mockResolvedValue({ ok: false, reason, detail: 'because' });
      const res = await app.request('/api/devices/me/pool/promote', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ issueId: ISSUE }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, reason, detail: 'because' });
    },
  );

  it('400s on a malformed body — that is a caller bug, not an outcome', async () => {
    const res = await app.request('/api/devices/me/pool/promote', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ issueId: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
    expect(promoteFromBacklog).not.toHaveBeenCalled();
  });

  it('401s without a device token', async () => {
    const res = await app.request('/api/devices/me/pool/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issueId: ISSUE }),
    });
    expect(res.status).toBe(401);
    expect(promoteFromBacklog).not.toHaveBeenCalled();
  });
});
