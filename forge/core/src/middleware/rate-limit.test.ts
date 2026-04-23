import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RateLimitRule } from '../config/rate-limits.js';
import { __resetRateLimitStore, getClientIp, rateLimit } from './rate-limit.js';

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
    const headers = { 'x-forwarded-for': '10.0.0.1' };

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

  it('resets the bucket after the window elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const app = makeApp({ windowMs: 10_000, max: 1, by: 'ip' }, 'test');
    const headers = { 'x-forwarded-for': '10.0.0.2' };

    expect((await app.request('/hit', { headers })).status).toBe(200);
    expect((await app.request('/hit', { headers })).status).toBe(429);

    vi.advanceTimersByTime(11_000);

    expect((await app.request('/hit', { headers })).status).toBe(200);
  });

  it('keeps independent buckets per IP', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, by: 'ip' }, 'test');

    expect((await app.request('/hit', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(
      200,
    );
    expect((await app.request('/hit', { headers: { 'x-forwarded-for': '2.2.2.2' } })).status).toBe(
      200,
    );
    expect((await app.request('/hit', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status).toBe(
      429,
    );
  });

  it('keeps independent buckets per user when by=user', async () => {
    const app = makeApp({ windowMs: 60_000, max: 1, by: 'user' }, 'test');
    const baseIp = { 'x-forwarded-for': '10.0.0.9' };

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
    expect((await app.request('/hit', { headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(
      200,
    );
    expect((await app.request('/hit', { headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(
      429,
    );
    // Different IP, no user → separate bucket.
    expect((await app.request('/hit', { headers: { 'x-forwarded-for': '4.4.4.4' } })).status).toBe(
      200,
    );
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
    const res = await app.request('/hit', { headers: { 'x-forwarded-for': '9.9.9.9' } });
    expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('2');
    expect(res.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);
  });
});

describe('getClientIp', () => {
  it('takes the left-most entry of x-forwarded-for', () => {
    const fakeCtx = {
      req: {
        header: (name: string) => {
          const map: Record<string, string> = {
            'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2',
          };
          return map[name.toLowerCase()];
        },
      },
    } as unknown as Parameters<typeof getClientIp>[0];
    expect(getClientIp(fakeCtx)).toBe('1.2.3.4');
  });

  it('falls back to x-real-ip when xff is absent', () => {
    const fakeCtx = {
      req: {
        header: (name: string) => {
          const map: Record<string, string> = { 'x-real-ip': '5.6.7.8' };
          return map[name.toLowerCase()];
        },
      },
    } as unknown as Parameters<typeof getClientIp>[0];
    expect(getClientIp(fakeCtx)).toBe('5.6.7.8');
  });

  it('returns undefined when no headers are present', () => {
    const fakeCtx = {
      req: { header: () => undefined },
    } as unknown as Parameters<typeof getClientIp>[0];
    expect(getClientIp(fakeCtx)).toBeUndefined();
  });
});
