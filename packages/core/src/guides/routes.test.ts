import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

// cm:why the router stopped being DB-free when the write tier landed, so the client is stubbed — the public GETs still never query, and this suite exists to prove they need no tenant context
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../db/client.js', () => ({ db: { select: vi.fn() } }));

const { errorHandler } = await import('../middleware/error.js');
type RequestIdVars = import('../middleware/request-id.js').RequestIdVars;
const { FORGE_GUIDES, getGuide, listGuides } = await import('./registry.js');
const { guideRoutes } = await import('./routes.js');

// Mirrors how index.ts mounts + errors this route in production, so the
// 404 shape and headers match what a real client sees.
function buildApp() {
  const app = new Hono<{ Variables: RequestIdVars }>();
  app.route('/', guideRoutes);
  app.onError(errorHandler);
  return app;
}

describe('guideRoutes — public, unauthenticated', () => {
  it('GET /guides returns the same body-free index as listGuides(), no Authorization header sent', async () => {
    const app = buildApp();
    const res = await app.request('/guides');
    expect(res.status).toBe(200);
    expect(res.headers.get('authorization')).toBeNull();
    const body = (await res.json()) as { guides: unknown };
    expect(body.guides).toEqual(listGuides());
  });

  it('GET /guides/:slug returns the full guide as JSON', async () => {
    const target = FORGE_GUIDES[0];
    expect(target).toBeDefined();
    if (!target) return;
    const app = buildApp();
    const res = await app.request(`/guides/${target.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { guide: unknown };
    expect(body.guide).toEqual(target);
  });

  it('GET /guides/:slug.md returns the SAME markdown body as the registry, as text/markdown', async () => {
    for (const guide of FORGE_GUIDES) {
      const app = buildApp();
      const res = await app.request(`/guides/${guide.slug}.md`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/markdown');
      const text = await res.text();
      expect(text).toBe(guide.body);
    }
  });

  it('GET /guides/:slug and /guides/:slug.md agree byte-for-byte with forge_guide get semantics', async () => {
    const target = getGuide('deploy-safety');
    expect(target).toBeDefined();
    if (!target) return;
    const app = buildApp();
    const jsonRes = await app.request(`/guides/${target.slug}`);
    const mdRes = await app.request(`/guides/${target.slug}.md`);
    const jsonBody = (await jsonRes.json()) as { guide: { body: string } };
    const mdBody = await mdRes.text();
    expect(jsonBody.guide.body).toBe(mdBody);
  });

  it('unknown slug -> 404 naming the valid slugs', async () => {
    const app = buildApp();
    const res = await app.request('/guides/not-a-real-guide');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('project-settings-and-test-credentials');
  });

  it('unknown slug with .md suffix -> 404', async () => {
    const app = buildApp();
    const res = await app.request('/guides/not-a-real-guide.md');
    expect(res.status).toBe(404);
  });

  it('sends no Authorization header requirement — a request without any auth header succeeds', async () => {
    const app = buildApp();
    const res = await app.request('/guides', { headers: {} });
    expect(res.status).toBe(200);
  });
});
