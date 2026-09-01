/**
 * ISS-894 — the device branch of `requireAnyAuth` is the one place in this repo
 * where a device token buys its owner's account authority, and the plan is to
 * delete it once a probe shows nothing calls it. That plan rests entirely on
 * the probe firing, and until this file existed the probe had never executed
 * once: `isSentryEnabled()` gating it, the level, a typo in the event name —
 * every one of those failure modes looks exactly like "no caller".
 *
 * So this is the positive control. It proves the call site, not the pipe to
 * Sentry; the pipe is confirmed separately against `forge-core`.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const verifyDeviceToken = vi.fn();
vi.mock('../auth/deviceToken.js', () => ({ verifyDeviceToken }));

const verifyUserToken = vi.fn();
vi.mock('../auth/jwt.js', () => ({ verifyUserToken }));

const captureMessage = vi.fn();
vi.mock('../observability/sentry.js', () => ({
  isSentryEnabled: () => true,
  Sentry: { captureMessage },
}));

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

describe('requireAnyAuth device branch', () => {
  it('still admits the device as its owner — this commit does not change that', async () => {
    verifyDeviceToken.mockResolvedValue({ id: 'dev-1', ownerId: 'owner-1' });
    const res = await asDevice();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'owner-1' });
  });

  // cm:guard the event NAME is the query someone will run in Sentry to decide whether to delete the branch, so it is asserted literally here. Renaming it in the middleware without renaming the saved search turns a live caller into apparent silence, which is the one wrong answer this whole mechanism exists to avoid.
  it('reports that the branch fired, naming the route and the device', async () => {
    verifyDeviceToken.mockResolvedValue({ id: 'dev-1', ownerId: 'owner-1' });
    await asDevice();

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const call = captureMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(call[0]).toBe('auth.device_token_on_data_plane');
    expect(call[1]).toMatchObject({
      level: 'warning',
      tags: { method: 'GET' },
      extra: { deviceId: 'dev-1', path: '/api/attachments/abc/download' },
    });
  });

  it('says nothing when a user token matched — the branch never ran', async () => {
    verifyUserToken.mockResolvedValue({ sub: 'user-1' });
    const res = await asDevice();
    expect(res.status).toBe(200);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('says nothing when the token is not a device either', async () => {
    verifyDeviceToken.mockResolvedValue(null);
    const res = await asDevice();
    expect(res.status).toBe(401);
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
