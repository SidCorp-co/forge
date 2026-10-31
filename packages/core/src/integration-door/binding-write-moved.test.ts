import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../middleware/error.js';

const P = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

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
vi.mock('../permissions/index.js', () => ({
  actorFor: (id: string) => ({ id }),
  projectResource: (id: string) => ({ id }),
  requireCan: async () => {},
  requireOrgHeld: async () => {},
}));
vi.mock('../integrations/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../integrations/index.js')>();
  return {
    ...real,
    findBindingWithConnectionById: async () => ({
      binding: { id: B, projectId: P, provider: 'sentry' },
      connection: { id: 'c1' },
    }),
  };
});

const { integrationsRoutes } = await import('./routes.js');

const patch = (body: unknown) => {
  // biome-ignore lint/suspicious/noExplicitAny: the routes' AuthVars carry more than a test sets
  const app = new Hono<any>().route('/', integrationsRoutes);
  app.onError(errorHandler as never);
  return app.request(`/${P}/integrations/${B}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
};

describe('PATCH /:projectId/integrations/:id: a binding write that moved', () => {
  it('is refused BINDING_WRITE_MOVED as 400 in the envelope, naming the door', async () => {
    const res = await patch({ active: false });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as {
      code: string;
      error: { code: string; message: string; refusals: { code: string; detail: string }[] };
    };
    expect(body.code).toBe('BINDING_WRITE_MOVED');
    expect(body.error.code).toBe('BINDING_WRITE_MOVED');
    expect(body.error.refusals[0]?.detail).toContain('PUT /api/projects/:projectId/bindings/');
  });
});
