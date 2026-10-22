import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The retired commit endpoint's names. `commitPath` is not one: a binding probe still carries it. */
const RETIRED = /commitUrl|live-commit-endpoint|liveCommit|liveProbeFrom|environments-live/;

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const ROOTS = ['packages/core/src', 'packages/web-v2/src', 'packages/contracts/src'];
/** The refusal names the field it refuses, so it is the one production file that may. */
const REFUSAL = 'packages/core/src/projects/environments.ts';

const isTest = (path: string) => /\.test\.tsx?$|\/__tests__\/|\.fixture\.ts$/.test(path);
const isSource = (path: string) => /\.(ts|tsx|mjs|js|md)$/.test(path);

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every production file under `roots` that names a retired name, other than those `allowed`. */
function retiredNamesIn(base: string, roots: readonly string[], allowed: ReadonlySet<string>) {
  return roots
    .flatMap((root) => walk(join(base, root), []))
    .map((path) => relative(base, path))
    .filter((path) => isSource(path) && !isTest(path) && !allowed.has(path))
    .filter((path) => RETIRED.test(readFileSync(join(base, path), 'utf8')));
}

describe('the live commit endpoint is retired (ISS-1339)', () => {
  it('names nowhere in production source but the refusal that names it', () => {
    expect(retiredNamesIn(REPO, ROOTS, new Set([REFUSAL]))).toEqual([]);
  });

  it('finds a retired name planted in another production file', () => {
    const base = mkdtempSync(join(tmpdir(), 'iss-1339-'));
    mkdirSync(join(base, 'packages/core/src/release-batch'), { recursive: true });
    writeFileSync(join(base, 'packages/core/src/release-batch/channel.ts'), 'live.commitUrl\n');
    writeFileSync(join(base, 'packages/core/src/release-batch/channel.test.ts'), 'commitUrl\n');
    try {
      expect(retiredNamesIn(base, ['packages/core/src'], new Set([REFUSAL]))).toEqual([
        'packages/core/src/release-batch/channel.ts',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
