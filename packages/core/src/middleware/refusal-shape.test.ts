// @direct-test-of packages/core/src/lib/body-shape.ts
// @direct-test-of packages/core/src/middleware/nearest-routes.ts
// ISS-828: a refused body is answered with the body the route accepts, read off its own schema; an
// unknown route names the routes nearest it; a key a read serves and the write refuses says so.
import { type Context, Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { parseLink } from '../ecosystem/link-rules.js';
import { issueMergeRoutes } from '../issues/merge-routes.js';
import { issueRoutes } from '../issues/routes.js';
import { requirementVerdictRoutes } from '../requirements/verdict-routes.js';
import { errorHandler, notFoundHandler } from './error.js';
import { declaredInputs } from './zod-validator.js';

type Mounted = { method: string; path: string; handler: unknown };

/** The route's own body validator, the one the real module declares, behind the shared error handler. */
function bodyOf(routes: Hono<never>, method: string, path: string) {
  const handlers = (routes.routes as Mounted[])
    .filter((r) => r.method === method && r.path === path)
    .map((r) => r.handler as object);
  const validator = handlers.find((h) => declaredInputs.get(h)?.target === 'json');
  if (!validator) throw new Error(`${method} ${path} declares no json body`);
  const app = new Hono();
  app.post('/', validator as never, (c: Context) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

async function refusal(app: Hono, body: unknown) {
  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { detail: string } };
}

const ROUTES = [
  {
    name: 'merge (a body with no hand-written hint)',
    app: () => bodyOf(issueMergeRoutes as never, 'POST', '/:id/merge'),
    fields: ['commit?: string', 'target?: string', 'note?: string', 'changedPaths?'],
  },
  {
    name: 'requirement verdict (a hand-written hint beside)',
    app: () => bodyOf(requirementVerdictRoutes as never, 'POST', '/:id/requirements/:req/verdicts'),
    fields: ['identity', 'verdict'],
  },
  {
    name: 'issue patch (a route hook that lets the failure through)',
    app: () => bodyOf(issueRoutes as never, 'PATCH', '/:id'),
    fields: ['title?: string', 'releaseNotes?', 'priority?'],
  },
];

describe('a strict body refusal carries the accepted shape', () => {
  for (const route of ROUTES) {
    it(`${route.name}: an unknown key lists the accepted fields`, async () => {
      const { status, body } = await refusal(route.app(), { reason: 'x' });
      expect(status).toBe(400);
      expect(body.detail).toContain('Accepted body (? marks an optional field)');
      for (const field of route.fields) expect(body.detail).toContain(field);
    });
  }

  it('shows a length limit read off the schema', async () => {
    const { body } = await refusal(ROUTES[0]?.app() as Hono, { bogus: 1 });
    expect(body.detail).toMatch(/note\?: string\(1\.\.\d+ chars\)/);
  });
});

describe('a link PUT of a document the read served', () => {
  it('names id, createdAt and updatedAt as server-owned', () => {
    const parsed = parseLink(
      {
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-10-31T00:00:00Z',
        updatedAt: '2026-10-31T00:00:00Z',
        bogus: 1,
      },
      '22222222-2222-4222-8222-222222222222',
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const byPath = new Map(parsed.refusals.map((r) => [r.path, r]));
    for (const key of ['id', 'createdAt', 'updatedAt']) {
      const row = byPath.get(`/${key}`);
      expect(row?.code).toBe('UNKNOWN_KEY');
      expect(row?.detail).toContain('server-owned');
      expect(row?.detail).toContain('Drop it');
    }
    expect(byPath.get('/bogus')?.detail).not.toContain('server-owned');
  });
});

describe('an unknown route under /api', () => {
  const app = new Hono();
  app.notFound(notFoundHandler);

  it('names the nearest served routes for the resource', async () => {
    const res = await app.request('/api/issues/abc/mrge');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain('No route serves it');
    expect(body.detail).toContain('POST /api/issues/{id}/merge');
  });

  it('answers a path outside /api with the plain 404', async () => {
    const res = await app.request('/nothing/here');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).not.toContain('Nearest');
  });
});
