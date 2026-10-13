// The run-session open's `policy` field, at the route only: a copy the box named reaches the
// open, and one core cannot read is refused by name before anything is written (ISS-1303).
// Split from `pool-routes.test.ts` because one file may not exceed 500 lines; the open itself
// is a stub here and the stamp it writes is `tests/integration/policy-copy-e2e.test.ts`'s.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: 'y'.repeat(32), NODE_ENV: 'test' },
}));

vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: async (t: string) =>
    t === 'good' ? { id: 'dev-1', ownerId: 'u-1', status: 'online' } : null,
}));

const openRunSession = vi.fn(async (_args: unknown) => ({ sessionId: 's9', runId: 'r9' }));

vi.mock('./run-session.js', () => ({
  openRunSession: (a: unknown) => openRunSession(a),
  closeRunSession: vi.fn(),
}));
vi.mock('../issues/issue-lease.js', () => ({
  IssueLeaseHeldError: class IssueLeaseHeldError extends Error {},
}));

const { deviceRunSessionRoutes } = await import('./run-session-routes.js');
const { errorHandler } = await import('../middleware/error.js');

const app = new Hono();
app.route('/api/devices', deviceRunSessionRoutes);
app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);

const open = (policy: unknown) =>
  app.request('/api/devices/me/run-sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer good', 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      issueKeys: ['ISS-957'],
      name: 'grp',
      ...(policy === undefined ? {} : { policy }),
    }),
  });

beforeEach(() => openRunSession.mockClear());

describe('POST /me/run-sessions with a policy copy', () => {
  it('carries the copy the box named through to the open', async () => {
    const policy = { named: true, plugin: 'forge@forge-local', version: '3.36.542' };
    expect((await open(policy)).status).toBe(200);
    expect(openRunSession.mock.calls.at(-1)?.[0]).toMatchObject({ policy });
  });

  it('opens with no policy at all for a box that sent none, which the open records as none named', async () => {
    expect((await open(undefined)).status).toBe(200);
    expect(openRunSession.mock.calls.at(-1)?.[0]).not.toHaveProperty('policy');
  });

  it('refuses a copy it cannot read naming the field, and opens nothing', async () => {
    const res = await open({ named: true, plugin: 'forge@forge-local', version: 'latest' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('policy.version');
    expect(openRunSession).not.toHaveBeenCalled();
  });
});
