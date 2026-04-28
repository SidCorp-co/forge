import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const { widgetBundleRoutes, invalidateBundleCache, setBundlePathForTesting } = await import(
  './bundle-routes.js'
);

const FIXTURE = '/* forge-widget test fixture */ console.log("hi")';

let tmpRoot = '';
let bundlePath = '';

function buildApp() {
  const app = new Hono();
  app.route('/widget', widgetBundleRoutes);
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  tmpRoot = await mkdtemp(join(tmpdir(), 'forge-widget-bundle-'));
  bundlePath = join(tmpRoot, 'forge-widget.js');
  await writeFile(bundlePath, FIXTURE, 'utf8');
  setBundlePathForTesting(bundlePath);
  invalidateBundleCache();
});

afterEach(async () => {
  setBundlePathForTesting(null);
  invalidateBundleCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('GET /widget/:slug/forge-widget.js', () => {
  it('404 on slug that fails the charset/length regex (no DB hit)', async () => {
    const res = await buildApp().request('/widget/Bad_SLUG/forge-widget.js');
    expect(res.status).toBe(404);
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('404 when slug is well-formed but project does not exist', async () => {
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

  it('reloads the bundle when the file mtime changes', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'p' }]);
    const first = await buildApp().request('/widget/forge-dev/forge-widget.js');
    const firstEtag = first.headers.get('etag');

    // Bump mtime ahead of the originally-cached value and rewrite contents.
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(bundlePath, `${FIXTURE}\n// updated`, 'utf8');

    selectLimit.mockResolvedValueOnce([{ id: 'p' }]);
    const second = await buildApp().request('/widget/forge-dev/forge-widget.js');
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).not.toBe(firstEtag);
    expect(await second.text()).toContain('// updated');
  });
});
