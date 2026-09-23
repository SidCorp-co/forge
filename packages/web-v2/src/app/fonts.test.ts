import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `next/font/google` downloads the binaries during `next build`, and one Coolify
// application builds `core` and `web-v2` together, so a web-only font fetch takes the
// BACKEND deploy down with it (ISS-854, 2026-08-13).

const APP = join(__dirname);
const LAYOUT = join(APP, 'layout.tsx');
const FONTS = join(APP, 'fonts');

const layout = () => readFileSync(LAYOUT, 'utf8');

describe('the app shell fetches no font at build time', () => {
  it('imports no font from next/font/google', () => {
    expect(existsSync(LAYOUT)).toBe(true);
    expect(layout()).not.toMatch(/next\/font\/google/);
  });

  it('declares its families through next/font/local instead', () => {
    expect(layout()).toMatch(/from ['"]next\/font\/local['"]/);
  });

  it('points every local family at a binary committed beside it', () => {
    const srcs = [...layout().matchAll(/src:\s*['"]\.\/fonts\/([^'"]+)['"]/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const file of srcs) expect(existsSync(join(FONTS, file))).toBe(true);
  });

  it('keeps the licence beside each binary the repo redistributes', () => {
    expect(existsSync(join(FONTS, 'OFL-hanken-grotesk.txt'))).toBe(true);
    expect(existsSync(join(FONTS, 'OFL-jetbrains-mono.txt'))).toBe(true);
  });
});

describe('the assertion can fail', () => {
  // A green here is worth nothing unless the matcher can go red, and the matcher —
  // not a mock of it — is what these two exercise.
  it('would refuse a layout that imported the google loader', () => {
    const planted = 'import { Hanken_Grotesk } from "next/font/google";\n';
    expect(planted).toMatch(/next\/font\/google/);
  });

  it('would refuse a family pointing at a binary that is not there', () => {
    expect(existsSync(join(FONTS, 'a-font-nobody-committed.woff2'))).toBe(false);
  });
});
