import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RateLimitRule } from '../config/rate-limits.js';
import { __resetRateLimitStore, rateLimit } from './rate-limit.js';

type UserVars = { user?: { id: string } };

function makeApp(rule: RateLimitRule, name: string) {
  const app = new Hono<{ Variables: UserVars }>();
  // Allow tests to inject a user into context via header.
  app.use('*', async (c, next) => {
    const uid = c.req.header('x-test-user');
    if (uid) c.set('user', { id: uid });
    await next();
  });
  app.use('/hit', rateLimit(rule, { name }));
  app.get('/hit', (c) => c.json({ ok: true }));
  // Map HTTPException to 429 with body, preserving cause details + Retry-After.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const cause = (err.cause ?? {}) as { code?: string; details?: unknown };
      return c.json(
        { code: cause.code ?? 'ERROR', message: err.message, details: cause.details },
        err.status,
      );
    }
    return c.json({ code: 'INTERNAL', message: 'boom' }, 500);
  });
  return app;
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    __resetRateLimitStore();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetRateLimitStore();
  });

  it('returns 429 with Retry-After once the bucket is full', async () => {
    const app = makeApp({ windowMs: 60_000, max: 2, by: 'ip' }, 'test');
    const headers = { 'x-forwarded-for': '10.0.0.1, 172.70.1.1' };

    const r1 = await app.request('/hit', { headers });
    const r2 = await app.request('/hit', { headers });
    const r3 = await app.request('/hit', { headers });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);

    const retryAfter = r3.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);

    const body = (await r3.json()) as { code: string; details: { retryAfterSeconds: number } };
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  // ISS-1421 r4 — judge-32 read a bare "rate limit exceeded" on register: a person is told, in a
  // capitalised sentence, how long until the next attempt is accepted.
  it('says in a sentence how long until the next attempt is accepted', async () => {
    const app = makeApp({ windowMs: 60 * 60_000, max: 1, by: 'ip' }, 'test');
    const headers = { 'x-forwarded-for': '10.0.0.9, 172.70.1.1' };
    await app.request('/hit', { headers });
    const refused = await app.request('/hit', { headers });

    const body = (await refused.json()) as { message: string };
    expect(body.message).toBe('Too many requests in a short time. Try again in 1 hour.');
  });

  it('resets the bucket after the window elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const app = makeApp({ windowMs: 10_000, max: 1, by: 'ip' }, 'test');
    const headers = { 'x-forwarded-for': '10.0.0.2, 172.70.1.1' };

    expect((await app.request('/hit', { headers })).status).toBe(200);
    expect((await app.request('/hit', { headers })).status).toBe(429);

    vi.advanceTimersByTime(11_000);

    expect((await app.request('/hit', { headers })).status).toBe(200);
  });

  it('keeps independent buckets per IP', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, by: 'ip' }, 'test');

    expect(
      (await app.request('/hit', { headers: { 'x-forwarded-for': '1.1.1.1, 172.70.1.1' } })).status,
    ).toBe(200);
    expect(
      (await app.request('/hit', { headers: { 'x-forwarded-for': '2.2.2.2, 172.70.1.1' } })).status,
    ).toBe(200);
    expect(
      (await app.request('/hit', { headers: { 'x-forwarded-for': '1.1.1.1, 172.70.1.1' } })).status,
    ).toBe(429);
  });

  it('keeps independent buckets per user when by=user', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, by: 'user' }, 'test');
    const baseIp = { 'x-forwarded-for': '10.0.0.9, 172.70.1.1' };

    expect(
      (await app.request('/hit', { headers: { ...baseIp, 'x-test-user': 'alice' } })).status,
    ).toBe(200);
    expect(
      (await app.request('/hit', { headers: { ...baseIp, 'x-test-user': 'bob' } })).status,
    ).toBe(200);
    expect(
      (await app.request('/hit', { headers: { ...baseIp, 'x-test-user': 'alice' } })).status,
    ).toBe(429);
  });

  it('falls back to per-IP when by=ip+user and no user is present', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, by: 'ip+user' }, 'test');

    // Same IP, no user → shared IP bucket → second hit 429.
    expect(
      (await app.request('/hit', { headers: { 'x-forwarded-for': '3.3.3.3, 172.70.1.1' } })).status,
    ).toBe(200);
    expect(
      (await app.request('/hit', { headers: { 'x-forwarded-for': '3.3.3.3, 172.70.1.1' } })).status,
    ).toBe(429);
    // Different IP, no user → separate bucket.
    expect(
      (await app.request('/hit', { headers: { 'x-forwarded-for': '4.4.4.4, 172.70.1.1' } })).status,
    ).toBe(200);
  });

  it('lets the request through when no identifier is available', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, by: 'ip' }, 'test');

    // No x-forwarded-for, no x-real-ip, no socket IP in hono test requests.
    const r1 = await app.request('/hit');
    const r2 = await app.request('/hit');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('exposes X-RateLimit-* headers on allowed responses', async () => {
    const app = makeApp({ windowMs: 60_000, max: 3, by: 'ip' }, 'test');
    const res = await app.request('/hit', {
      headers: { 'x-forwarded-for': '9.9.9.9, 172.70.1.1' },
    });
    expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('2');
    expect(res.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);
  });
});

// ISS-1421 r5 — the limiter keyed on the left-most X-Forwarded-For entry, which the client writes:
// judge-33 sent ten registers in six minutes on beta against a limit of three an hour, none refused.
// Behind Cloudflare and Traefik (TRUSTED_PROXY_HOPS=2) the client is the entry two from the right.
describe('a forged X-Forwarded-For entry', () => {
  beforeEach(() => {
    __resetRateLimitStore();
  });

  it('does not lift the limit: every attempt is counted against the address the proxies vouch for', async () => {
    const app = makeApp({ windowMs: 3_600_000, max: 3, by: 'ip' }, 'register');
    const statuses: number[] = [];
    for (let n = 1; n <= 5; n++) {
      const res = await app.request('/hit', {
        headers: { 'x-forwarded-for': `198.51.100.${n}, 203.0.113.7, 172.70.1.1` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('counts a header too short to have crossed both proxies against the connection itself', async () => {
    const app = makeApp({ windowMs: 3_600_000, max: 2, by: 'ip' }, 'register');
    const socket = { incoming: { socket: { remoteAddress: '10.0.1.5' } } };
    const statuses: number[] = [];
    for (let n = 1; n <= 3; n++) {
      const res = await app.request(
        '/hit',
        { headers: { 'x-forwarded-for': `198.51.100.${n}` } },
        socket,
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('keeps two real clients behind the same proxies apart', async () => {
    const app = makeApp({ windowMs: 3_600_000, max: 1, by: 'ip' }, 'register');
    const from = (client: string) =>
      app.request('/hit', { headers: { 'x-forwarded-for': `${client}, 172.70.1.1` } });
    expect((await from('203.0.113.7')).status).toBe(200);
    expect((await from('203.0.113.8')).status).toBe(200);
    expect((await from('203.0.113.7')).status).toBe(429);
  });
});
