import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `pnpm verify` must answer the same from any checkout path. Biome found neither a nested
 * `root: false` config nor the React and Next lint domains it detects from a manifest when the
 * checkout sat under a directory named `.cache`, so one commit was red there and green elsewhere
 * (ISS-1132). Each case lays the same fixture out under a path with a `.cache` component and under
 * one without, runs the command `verify` runs, and compares what biome reported.
 *
 * @gate-input whole-tree
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIOME = join(ROOT, 'node_modules', '.bin', 'biome');
const HOLDER = mkdtempSync(join(tmpdir(), 'forge-biome-path-'));
afterAll(() => rmSync(HOLDER, { recursive: true, force: true }));

const PATHS = { cached: ['.cache', 'checkout'], plain: ['plain', 'checkout'] };

function layout(label, files) {
  const dir = join(HOLDER, ...PATHS[label]);
  for (const [rel, from] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    if (from.copy) copyFileSync(join(ROOT, from.copy), join(dir, rel));
    else writeFileSync(join(dir, rel), from.text);
  }
  return dir;
}

function report(cwd, args) {
  const run = spawnSync(BIOME, [...args, '--reporter=json', '--max-diagnostics=500'], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  const diagnostics = JSON.parse(run.stdout).diagnostics ?? [];
  const byCategory = {};
  for (const d of diagnostics) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
  return byCategory;
}

const both = (files, sub, args) =>
  ['cached', 'plain'].map((label) => report(join(layout(label, files), sub), args));

describe('biome answers the same under a path with a .cache component', () => {
  it('formats scripts/ by the one config the repo declares, wherever the checkout sits', () => {
    const [cached, plain] = both(
      {
        'biome.json': { copy: 'biome.json' },
        'scripts/x.mjs': { text: 'const a = "x"\nconsole.log(a)\n' },
      },
      '',
      ['check', 'scripts'],
    );
    expect(plain.format, 'the repo config must reach scripts/ at all').toBeGreaterThan(0);
    expect(cached).toEqual(plain);
  });

  it('applies the React lint domain to web-v2 whether or not biome can detect it from the path', () => {
    const [cached, plain] = both(
      {
        'packages/web-v2/biome.json': { copy: 'packages/web-v2/biome.json' },
        'packages/web-v2/package.json': { copy: 'packages/web-v2/package.json' },
        'packages/web-v2/.gitignore': { text: 'node_modules\n' },
        'packages/web-v2/src/list.tsx': {
          text: 'export const List = ({ xs }: { xs: string[] }) => (\n  <ul>{xs.map((x, i) => <li key={i}>{x}</li>)}</ul>\n);\n',
        },
      },
      'packages/web-v2',
      ['check', 'src'],
    );
    expect(plain['lint/suspicious/noArrayIndexKey'], 'the React domain must be on at all').toBe(1);
    expect(cached).toEqual(plain);
  });

  it('keeps no nested root:false config, which biome does not discover below a .cache path', () => {
    const listed = spawnSync('git', ['ls-files', '--', 'biome.json', '**/biome.json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const configs = listed.stdout.split('\n').filter(Boolean);
    expect(configs).toContain('biome.json');
    for (const file of configs) {
      const doc = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
      expect(
        doc.root,
        `${file} is a nested config biome does not find under a .cache path`,
      ).not.toBe(false);
    }
  });
});
