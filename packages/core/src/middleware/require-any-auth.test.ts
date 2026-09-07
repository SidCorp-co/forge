/**
 * ISS-927 — the device branch of `requireAnyAuth` is gone, and this file is the
 * proof it stays gone.
 *
 * It used to be the positive control for the Sentry probe that measured the
 * branch: `isSentryEnabled()` gating it, the level, a typo in the event name —
 * every one of those failure modes looked exactly like "no caller", so the
 * probe needed a test before its silence could be trusted. What retired the
 * branch in the end was not that silence but the token: an unattended caller
 * now holds a `job:` or `session:` PAT, so the one place a device silently
 * acquired its owner's account authority has nothing left to serve.
 *
 * A device token reaching this middleware is now a 401, and that is the whole
 * assertion — a loud break naming itself, in place of a silent substitution.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const verifyDeviceCredential = vi.fn();
vi.mock('../auth/device-credential.js', () => ({ verifyDeviceCredential }));

const verifyUserToken = vi.fn();
vi.mock('../auth/jwt.js', () => ({ verifyUserToken }));

const { requireAnyAuth } = await import('./require-any-auth.js');

function app() {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.get('/api/attachments/:id/download', requireAnyAuth(), (c) =>
    c.json({ userId: c.get('userId') }),
  );
  return a;
}

const asDevice = () =>
  app().request('http://localhost/api/attachments/abc/download', {
    headers: { authorization: 'Bearer device-token' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  verifyUserToken.mockRejectedValue(new Error('not a user token'));
});

describe('requireAnyAuth', () => {
  it('refuses a valid device token instead of admitting it as its owner', async () => {
    verifyDeviceCredential.mockResolvedValue({ id: 'dev-1', ownerId: 'owner-1' });
    const res = await asDevice();
    expect(res.status).toBe(401);
  });

  // cm:guard this is the assertion, not `status === 401`. A 401 would also be produced by the middleware simply failing to reach a still-present device branch, and the whole defect class this issue closes is a credential path that looks retired and is not. `verifyDeviceCredential` being uncalled is the only evidence that no device code path survives here.
  it('does not so much as verify a device token — the branch is gone, not merely refusing', async () => {
    verifyDeviceCredential.mockResolvedValue({ id: 'dev-1', ownerId: 'owner-1' });
    await asDevice();
    expect(verifyDeviceCredential).not.toHaveBeenCalled();
  });

  it('still admits a user JWT', async () => {
    verifyUserToken.mockResolvedValue({ sub: 'user-1' });
    const res = await asDevice();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user-1' });
  });

  it('refuses a token that is neither a user JWT nor a PAT', async () => {
    const res = await asDevice();
    expect(res.status).toBe(401);
  });
});
