// @direct-test-of packages/core/src/middleware/pat-rest-surface.ts
// @direct-test-of packages/core/src/middleware/nearest-routes.ts
// ISS-828: an agent's token refused on a route nothing serves is answered with the nearest served
// routes, the same as any other caller; the token surface answers that 404 before the app's own
// not-found handler runs, so it has to name them itself.
import { type Context, Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from './error.js';
import type { RequestIdVars } from './request-id.js';

vi.mock('./require-pat.js', () => ({
  authenticatePat: async () => ({ kind: 'pat', tokenId: 't', userId: 'u', scopes: ['read'] }),
}));

const { beginPatRequest } = await import('./pat-rest-surface.js');

const app = new Hono<{ Variables: RequestIdVars }>();
app.use('/api/*', async (c, next) => {
  await beginPatRequest(c, 'forge_pat_test');
  await next();
});
app.post('/api/issues/:id/merge', (c: Context) => c.json({ ok: true }));
app.onError(errorHandler);

describe('a token on an unknown route under /api', () => {
  it('names the nearest served routes for the resource', async () => {
    const res = await app.request('/api/issues/abc/mrge');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      code: string;
      detail: string;
      details?: { nearest?: string[] };
    };
    expect(body.code).toBe('NOT_FOUND');
    expect(body.detail).toContain('whatever the token holds');
    expect(body.detail).toContain('Nearest served: ');
    expect(body.detail).toContain('POST /api/issues/{id}/merge');
    expect(body.details?.nearest).toContain('POST /api/issues/{id}/merge');
  });

  it('names none where no served route shares the resource', async () => {
    const res = await app.request('/api/nowhere-at-all/x');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).not.toContain('Nearest');
  });
});
