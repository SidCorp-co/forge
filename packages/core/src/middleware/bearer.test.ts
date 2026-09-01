/**
 * ISS-894 — the five auth middlewares now read their token through one pair of
 * functions instead of five copies of the same regex. That collapse is only
 * safe if it preserved every distinction the copies encoded, so this pins the
 * three that were load-bearing: the cookie standing in for a missing header,
 * the header winning when both are present, and `absent` staying distinct from
 * `malformed` for the `/mcp` challenge.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));

const { parseBearerHeader, readBearerToken } = await import('./bearer.js');

function probe() {
  const app = new Hono();
  app.get('/read', (c) => c.json({ token: readBearerToken(c) }));
  app.get('/parse', (c) => c.json(parseBearerHeader(c)));
  return app;
}

const call = (path: string, headers: Record<string, string> = {}) =>
  probe().request(`http://localhost${path}`, { headers });

describe('readBearerToken', () => {
  it('takes the bearer token out of the header', async () => {
    const res = await call('/read', { authorization: 'Bearer abc123' });
    expect(await res.json()).toEqual({ token: 'abc123' });
  });

  it('accepts a lower-case scheme — the regex is case-insensitive', async () => {
    const res = await call('/read', { authorization: 'bearer abc123' });
    expect(await res.json()).toEqual({ token: 'abc123' });
  });

  it('falls back to the forge_auth cookie when no header is sent', async () => {
    const res = await call('/read', { cookie: 'forge_auth=cookie-token' });
    expect(await res.json()).toEqual({ token: 'cookie-token' });
  });

  it('prefers the header when both are present', async () => {
    const res = await call('/read', {
      authorization: 'Bearer header-token',
      cookie: 'forge_auth=cookie-token',
    });
    expect(await res.json()).toEqual({ token: 'header-token' });
  });

  it('falls back to the cookie when the header carries no bearer token', async () => {
    const res = await call('/read', {
      authorization: 'Basic dXNlcjpwYXNz',
      cookie: 'forge_auth=cookie-token',
    });
    expect(await res.json()).toEqual({ token: 'cookie-token' });
  });

  it('401s UNAUTHENTICATED when neither is present', async () => {
    const res = await call('/read');
    expect(res.status).toBe(401);
  });
});

describe('parseBearerHeader', () => {
  it('reports absent and malformed separately — /mcp answers them differently', async () => {
    expect(await (await call('/parse')).json()).toEqual({ kind: 'absent' });
    expect(await (await call('/parse', { authorization: 'Basic x' })).json()).toEqual({
      kind: 'malformed',
    });
  });

  it('ignores the cookie — a device is not a browser and has no cookie jar', async () => {
    const res = await call('/parse', { cookie: 'forge_auth=cookie-token' });
    expect(await res.json()).toEqual({ kind: 'absent' });
  });
});
