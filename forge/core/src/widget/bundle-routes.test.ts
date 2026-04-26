import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const { widgetBundleRoutes, invalidateBundleCache } = await import('./bundle-routes.js');

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', '..', 'public');
const bundlePath = resolve(publicDir, 'forge-widget.js');
const FIXTURE = '/* forge-widget test fixture */ console.log("hi")';

function buildApp() {
  const app = new Hono();
  app.route('/widget', widgetBundleRoutes);
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  invalidateBundleCache();
  await mkdir(publicDir, { recursive: true });
  await writeFile(bundlePath, FIXTURE, 'utf8');
});

afterEach(async () => {
  invalidateBundleCache();
  await rm(bundlePath, { force: true });
});

describe('GET /widget/:slug/forge-widget.js', () => {
  it('404 on unknown slug', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request('/widget/no-such/forge-widget.js');
    expect(res.status).toBe(404);
  });

  it('200 with ETag + Cache-Control on known slug', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p' }]);
    const res = await buildApp().request('/widget/forge-dev/forge-widget.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('etag')).toMatch(/^".+"$/);
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    const body = await res.text();
    expect(body).toBe(FIXTURE);
  });

  it('304 on If-None-Match', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p' }]);
    const first = await buildApp().request('/widget/forge-dev/forge-widget.js');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    selectLimit.mockResolvedValueOnce([{ id: 'p' }]);
    const second = await buildApp().request('/widget/forge-dev/forge-widget.js', {
      headers: { 'If-None-Match': etag ?? '' },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
  });
});
