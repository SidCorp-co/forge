import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  absentPrerequisites,
  blockedAside,
  couldNotStart,
  PREREQUISITES,
  remedyLines,
} from './prerequisite.mjs';

let root;

function place(rel) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '');
}

function placeAll(name) {
  for (const p of PREREQUISITES[name].paths) place(join(p, '.keep'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-prereq-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('absentPrerequisites', () => {
  it('reports nothing when the checkout has everything the check declared', () => {
    placeAll('deps');
    place('packages/observability/dist/index.js');
    expect(absentPrerequisites(root, ['deps', 'observability-build'])).toEqual([]);
  });

  it('names the absent one, and the command that installs it', () => {
    const missing = absentPrerequisites(root, ['deps']);
    expect(missing).toHaveLength(1);
    expect(missing[0].what).toContain('node_modules');
    expect(missing[0].remedy).toBe('pnpm install --frozen-lockfile');
  });

  // cm:why the two are separate prerequisites because they fail at different moments and only one of them is `pnpm install`: measured 2026-09-07, an installed workspace whose `@forge/observability` was never built gave `tsc` eight `Cannot find module` errors, which read as broken imports in the repo rather than as an unbuilt dependency
  it('separates an uninstalled workspace from an unbuilt one', () => {
    placeAll('deps');
    const missing = absentPrerequisites(root, ['deps', 'observability-build']);
    expect(missing.map((m) => m.name)).toEqual(['observability-build']);
    expect(missing[0].remedy).toBe('pnpm --filter @forge/observability build');
  });

  // cm:guard EVERY declared path, not the first. `node_modules` at the repo root exists after a partial or interrupted install while the package-level ones do not, and a check that resolves only the root would call that checkout ready and hand its `biome: not found` back as a lint verdict.
  it('is absent when any one of its declared paths is missing', () => {
    place('node_modules/.keep');
    expect(absentPrerequisites(root, ['deps'])).toHaveLength(1);
  });

  it('declares an undeclared prerequisite name absent rather than present', () => {
    const missing = absentPrerequisites(root, ['no-such-thing']);
    expect(missing).toHaveLength(1);
    expect(missing[0].what).toContain('unknown prerequisite');
  });

  it('asks nothing of a check that declares no prerequisite', () => {
    expect(absentPrerequisites(root, undefined)).toEqual([]);
    expect(absentPrerequisites(root, [])).toEqual([]);
  });
});

describe('couldNotStart', () => {
  it('is true only for a process the OS refused to start', () => {
    expect(couldNotStart({ error: { code: 'ENOENT' } })).toBe(true);
    expect(couldNotStart({ status: 1, stdout: "Cannot find module './broken'" })).toBe(false);
    expect(couldNotStart({ error: { code: 'EACCES' } })).toBe(false);
    expect(couldNotStart(undefined)).toBe(false);
  });
});

describe('the sentence a reader gets', () => {
  it('carries the remedy, so the next step is in the message', () => {
    const missing = absentPrerequisites(root, ['deps']);
    expect(remedyLines(missing)[0]).toContain('pnpm install --frozen-lockfile');
  });

  // cm:guard the aside must never read as a verdict on the repo. A gate that could not run has measured nothing, so no wording here may name a rule, a violation or a count.
  it('says it could not run and counts the rest', () => {
    const missing = absentPrerequisites(root, ['deps', 'observability-build']);
    const aside = blockedAside(missing);
    expect(aside).toMatch(/^could not run — /);
    expect(aside).toContain('+1 more');
  });

  it('still says something when nothing was named', () => {
    expect(blockedAside([])).toBe('could not run — prerequisite absent');
  });
});
