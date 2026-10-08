// @gate-input whole-tree — it runs the repository's own biome over copies of its configuration.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BIOME, biomeView } from './verify-memo-native.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['scripts/biome.json', 'scripts/a.mjs'];
let base;

/** A checkout holding the repository's scripts config and one file formatted by it, under `parent`. */
function checkoutUnder(parent) {
  const root = join(base, parent, 'checkout');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'scripts', 'biome.json'), join(root, 'scripts', 'biome.json'));
  writeFileSync(join(root, 'scripts', 'a.mjs'), "export const a = 'x';\n");
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  return root;
}

const verdictOf = (root) =>
  spawnSync(join(root, 'node_modules', '.bin', 'biome'), ['check', 'scripts'], {
    cwd: root,
    encoding: 'utf8',
  }).status;

beforeEach(() => {
  // Not `tmpdir()`: a run that sets TMPDIR below `~/.cache` puts every place in the one biome misreads.
  base = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'verify-memo-native-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('what biome makes of a place', () => {
  it('finds the configuration files of a checkout, nested or hidden, and no other file', () => {
    expect(
      BIOME.configs(['scripts/biome.json', 'a/.biome.jsonc', 'biome.jsonc.bak', 'src/biome.ts']),
    ).toEqual(['a/.biome.jsonc', 'scripts/biome.json']);
  });

  it('says so, and does not fail, where biome is not installed', () => {
    const root = join(base, 'bare');
    mkdirSync(root);
    expect(biomeView(root, FILES)).toBe('biome is not installed here');
  });

  it('answers alike for two places only where biome lints the same files alike in both', () => {
    const places = ['plain', '.cache/under', 'cache/under', '.config/nested'].map(checkoutUnder);
    const views = places.map((root) => biomeView(root, FILES));
    const verdicts = places.map(verdictOf);
    for (const [i, view] of views.entries()) {
      for (const [j, other] of views.entries()) {
        if (view === other)
          expect(verdicts[i], `${places[i]} against ${places[j]}`).toBe(verdicts[j]);
      }
    }
  });

  it('answers alike for two places that read alike, so worktrees of one repository still share', () => {
    const here = checkoutUnder('plain');
    const there = checkoutUnder('.claude/worktrees/another');
    expect(biomeView(here, FILES)).toBe(biomeView(there, FILES));
    expect(verdictOf(here)).toBe(0);
    expect(verdictOf(there)).toBe(0);
  });

  it('stays the same for the same place asked twice', () => {
    const root = checkoutUnder('plain');
    expect(biomeView(root, FILES)).toBe(biomeView(root, FILES));
  });
});
