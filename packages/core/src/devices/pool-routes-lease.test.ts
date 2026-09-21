// The two lease routes only: what a box reads back when it asks who holds an
// issue and when it gives one back. Split from `pool-routes.test.ts` because
// both files are route-shape suites and one file may not exceed 500 lines; the
// readers themselves are stubs here, so a change to the RESPONSE — the key a
// runner decodes, the status code a refusal arrives on — fails here and
// nowhere else.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: 'y'.repeat(32), NODE_ENV: 'test' },
}));

vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: async (t: string) =>
    t === 'good' ? { id: 'dev-1', ownerId: 'u-1', status: 'online' } : null,
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
type LeaseKeyAnswer =
  | { ok: true; key: { issueKey: string; projectId: string | null } }
  | { ok: false; refusal: { code: string; status: 400 | 404; message: string } };
const resolveLeaseKey = vi.fn(
  async (a: { deviceId: string; rawKey: string; projectId?: string | null }) =>
    ({ ok: true, key: { issueKey: a.rawKey, projectId: a.projectId ?? null } }) as LeaseKeyAnswer,
);
type ReleaseAnswer =
  | { released: true; projectId: string }
  | { released: false; reason: 'not_held' | 'ambiguous'; projectIds: string[] };
const releaseIssueLease = vi.fn(
  async (_a: unknown) => ({ released: true, projectId: 'proj-1' }) as ReleaseAnswer,
);

vi.mock('../issues/issue-lease.js', () => ({
  readDeviceIssueLease: (a: unknown) => readDeviceIssueLease(a),
  resolveLeaseKey: (a: { deviceId: string; rawKey: string; projectId?: string | null }) =>
    resolveLeaseKey(a),
}));
vi.mock('./run-session.js', () => ({
  openRunSession: vi.fn(),
  closeRunSession: vi.fn(),
  readRunSessionTerminal: vi.fn(async () => null),
  isIssueLeaseHeld: vi.fn(),
  releaseIssueLease: (a: unknown) => releaseIssueLease(a),
}));
vi.mock('./pool.js', () => ({ readPool: vi.fn(async () => []) }));
vi.mock('./admissible.js', () => ({ readAdmissibleIssues: vi.fn(async () => []) }));
vi.mock('./claim.js', () => ({
  claimJobForMaster: vi.fn(),
  releaseAllHeldBySession: vi.fn(),
  releaseJobFromMaster: vi.fn(),
}));
vi.mock('./master-limit.js', () => ({
  recordMasterLimit: vi.fn(async () => ({ runnerId: 'r-1' })),
  clearMasterLimit: vi.fn(async () => ({ runnerId: 'r-1' })),
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

beforeEach(() => {
  readDeviceIssueLease
    .mockReset()
    .mockResolvedValue({ held: false, heldByThisDevice: false, holder: null });
  resolveLeaseKey.mockReset().mockImplementation(async (a) => ({
    ok: true,
    key: { issueKey: a.rawKey, projectId: a.projectId ?? null },
  }));
  releaseIssueLease.mockReset().mockResolvedValue({ released: true, projectId: 'proj-1' });
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
      projectId: null,
    });
  });

  it('refuses a caller with no device credential', async () => {
    const res = await app.request(path);
    expect(res.status).toBe(401);
  });
});

/**
 * ISS-1139 — a release answers for the lease it removed, or says it removed none.
 *
 * The runner's `release_lease` reads the status code and `is_returned()` reads
 * the body, so these two are the whole of what a box learns from a give-back.
 */
describe('DELETE /me/issue-leases/:issueKey', () => {
  const path = '/api/devices/me/issue-leases/ISS-357';

  it('carries the project the lease was released for', async () => {
    releaseIssueLease.mockResolvedValue({ released: true, projectId: 'proj-7' });

    const res = await app.request(path, { method: 'DELETE', headers: AUTH });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, issueKey: 'ISS-357', projectId: 'proj-7' });
  });

  it('releases the canonical key the resolver answered, not the one in the path', async () => {
    resolveLeaseKey.mockResolvedValue({ ok: true, key: { issueKey: 'ISS-880', projectId: 'p-2' } });
    releaseIssueLease.mockResolvedValue({ released: true, projectId: 'p-2' });

    await app.request('/api/devices/me/issue-leases/FD-880', { method: 'DELETE', headers: AUTH });

    expect(releaseIssueLease).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      issueKey: 'ISS-880',
      projectId: 'p-2',
    });
  });

  it('refuses a release that removed nothing rather than acknowledging it', async () => {
    releaseIssueLease.mockResolvedValue({ released: false, reason: 'not_held', projectIds: [] });

    const res = await app.request(path, { method: 'DELETE', headers: AUTH });

    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'ISSUE_LEASE_NOT_HELD',
    });
  });

  it('names the canonical key in the refusal a box reads', async () => {
    releaseIssueLease.mockResolvedValue({ released: false, reason: 'not_held', projectIds: [] });

    const res = await app.request(path, { method: 'DELETE', headers: AUTH });

    expect(`${((await res.json()) as { message: string }).message}`).toContain('ISS-357');
  });

  it('refuses a key it cannot narrow to one project, naming each of them', async () => {
    releaseIssueLease.mockResolvedValue({
      released: false,
      reason: 'ambiguous',
      projectIds: ['p-a', 'p-b'],
    });

    const res = await app.request(path, { method: 'DELETE', headers: AUTH });
    const body = (await res.json()) as { code: string; message: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('ISSUE_LEASE_AMBIGUOUS');
    expect(`${body.message}`).toContain('p-a');
    expect(`${body.message}`).toContain('p-b');
  });

  it('answers a key the resolver refused with the resolver status and code', async () => {
    resolveLeaseKey.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'ISSUE_LEASE_KEY_UNKNOWN_PREFIX',
        status: 404,
        message: '`ZZ-880` names the issue prefix `ZZ`, which no project answers to',
      },
    });

    const res = await app.request('/api/devices/me/issue-leases/ZZ-880', {
      method: 'DELETE',
      headers: AUTH,
    });

    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'ISSUE_LEASE_KEY_UNKNOWN_PREFIX',
    });
    expect(
      releaseIssueLease,
      'a key that reaches no lease must not reach a DELETE',
    ).not.toHaveBeenCalled();
  });

  it('asks the resolver on behalf of the calling device', async () => {
    await app.request(path, { method: 'DELETE', headers: AUTH });

    expect(
      resolveLeaseKey,
      'a prefix is resolved against the projects THIS box reaches, so the resolver needs to know which box asked',
    ).toHaveBeenCalledWith({ deviceId: 'dev-1', rawKey: 'ISS-357', projectId: null });
  });

  it('refuses a projectId that is not a uuid', async () => {
    const res = await app.request(`${path}?projectId=nope`, { method: 'DELETE', headers: AUTH });

    expect(res.status).toBe(400);
  });

  it('refuses a caller with no device credential', async () => {
    const res = await app.request(path, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});
