// A core told to serve a web build it cannot read never starts, and says how to fix it (build.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadWebBuild } from './build.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = { basePath: '/forge', routes: ['/'], helpSlugs: [] };

function build(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-web-build-'));
  dirs.push(dir);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe('the web build core serves', () => {
  it('takes its base path from the manifest, and lists every file but the page and the manifest', () => {
    const loaded = loadWebBuild(
      build({
        'index.html': '<!doctype html>',
        'web-host.json': JSON.stringify(MANIFEST),
        'assets/a-1.js': '1',
        'favicon.svg': '<svg/>',
      }),
    );
    expect(loaded.basePath).toBe('/forge');
    expect(loaded.indexHtml).toBe('<!doctype html>');
    expect([...loaded.files].sort()).toEqual(['/assets/a-1.js', '/favicon.svg']);
  });

  it('is refused naming the missing page, and the build to run', () => {
    expect(() => loadWebBuild(build({ 'web-host.json': JSON.stringify(MANIFEST) }))).toThrow(
      /holds no index\.html: build the web \(`pnpm --filter web-v2 build`\) or unset WEB_DIST_DIR/,
    );
  });

  it('is refused naming the missing manifest', () => {
    expect(() => loadWebBuild(build({ 'index.html': '' }))).toThrow(/holds no web-host\.json/);
  });

  it('is refused when the manifest is not JSON, or names the field that is wrong', () => {
    expect(() => loadWebBuild(build({ 'index.html': '', 'web-host.json': '{' }))).toThrow(
      /web-host\.json is not JSON/,
    );
    expect(() =>
      loadWebBuild(
        build({ 'index.html': '', 'web-host.json': JSON.stringify({ ...MANIFEST, routes: [] }) }),
      ),
    ).toThrow(/is refused, `routes` is not a non-empty list of paths/);
  });
});
