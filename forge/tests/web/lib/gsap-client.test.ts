import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

describe('gsap-client', () => {
  it('imports without throwing in a window-less environment (SSR / Node) and exports both names', async () => {
    const mod = await import('@/lib/gsap-client');
    expect(mod.gsap).toBeDefined();
    expect(mod.ScrollTrigger).toBeDefined();
  });
});

describe('gsap import audit', () => {
  // forge/tests/web/lib/gsap-client.test.ts → forge/web/src
  const SRC_ROOT = join(__dirname, '..', '..', '..', 'web', 'src');
  const ALLOWED = [join('lib', 'gsap-client.ts')];

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) yield p;
    }
  }

  it('forbids dynamic gsap imports anywhere in forge/web/src', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      if (/await\s+import\(['"]gsap/.test(content)) {
        offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('forbids direct gsap imports outside lib/gsap-client', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (ALLOWED.includes(rel)) continue;
      const content = readFileSync(file, 'utf8');
      if (/from\s+['"]gsap['"\/]/.test(content)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
