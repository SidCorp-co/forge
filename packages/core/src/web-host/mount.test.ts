// hostTheWeb runs as core is imported (route-registry.ts, from index.ts), before a test or the
// server's boot has read its settings: it reads none until a request arrives, so an environment set
// after the import is the one core serves under (mount.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  WEB_DIST_DIR: undefined as string | undefined,
  FORGE_DEMO_MODE: false,
}));
const reads = vi.hoisted(() => [] as string[]);
vi.mock('../lib/env.js', () => ({
  env: new Proxy(settings, {
    get: (target, key: string) => {
      reads.push(key);
      return target[key as keyof typeof target];
    },
  }),
}));

import { hostTheWeb, servedWebBuild } from './mount.js';

const dir = mkdtempSync(join(tmpdir(), 'forge-web-mount-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, 'assets'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>web</title>');
writeFileSync(
  join(dir, 'web-host.json'),
  JSON.stringify({ basePath: '', routes: ['/'], helpSlugs: [] }),
);

describe('mounting the web host', () => {
  it('reads no setting at mount, and serves the build WEB_DIST_DIR names once a request arrives', async () => {
    const app = new Hono();
    hostTheWeb(app);
    app.get('/api/health', (c) => c.text('ok'));
    expect(reads).toEqual([]);

    settings.WEB_DIST_DIR = dir;
    const page = await app.request('/', { headers: { accept: 'text/html' } });
    expect(await page.text()).toBe('<!doctype html><title>web</title>');
    expect(await (await app.request('/api/health')).text()).toBe('ok');
    expect(servedWebBuild()?.dir).toBe(dir);
  });
});
