/**
 * @direct-test-of packages/core/src/body/errors.ts
 * @direct-test-of packages/core/src/body/validate.ts
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

vi.mock('../middleware/auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../middleware/auth.js')>();
  return {
    ...real,
    requireAuth:
      () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
        c.set('userId', 'u1');
        await next();
      },
    assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
  };
});

const { bodyRoutes } = await import('./routes.js');

const preview = (raw: string, format: 'html' | 'markdown' = 'html') => {
  // biome-ignore lint/suspicious/noExplicitAny: the routes' AuthVars carry more than a test sets
  const app = new Hono<any>().route('/', bodyRoutes);
  app.onError(errorHandler as never);
  return app.request('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw, format }),
  });
};

type Body = {
  code: string;
  detail: string;
  error: { code: string; refusals: { code: string; detail: string }[] };
};

describe('POST /preview: a body that is not markup', () => {
  it.each([
    ['an unclosed tag', '<p>never closed'],
    ['a tag that closes nothing', 'text</p>'],
    ['markup outside the allowlist', '<forge-card>x</forge-card>'],
  ])('%s is BODY_INVALID, 400, in the envelope, quoting where', async (_name, raw) => {
    const res = await preview(raw);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as Body;
    expect(body.code).toBe('BODY_INVALID');
    expect(body.error.code).toBe('BODY_INVALID');
    expect(body.error.refusals[0]?.code).toBe('BODY_INVALID');
    expect(body.detail).toBe(body.error.refusals[0]?.detail);
    expect(body.detail.length).toBeGreaterThan(10);
  });

  it('a readable body is answered 200', async () => {
    expect((await preview('<p>fine</p>')).status).toBe(200);
  });
});
