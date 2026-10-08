import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pattern `verify` reads this checker's scan count with, taken from its own table. */
const SCANNED = new RegExp(
  /label: 'source-language'[\s\S]*?scanned: \/(.*)\/,/.exec(
    readFileSync(join(HERE, 'verify.mjs'), 'utf8'),
  )[1],
);

describe('check-source-language --all', () => {
  let root;
  const run = () => {
    const r = spawnSync('node', ['scripts/check-source-language.mjs', '--all'], {
      cwd: root,
      encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'source-language-'));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'packages/core/src'), { recursive: true });
    copyFileSync(
      join(HERE, 'check-source-language.mjs'),
      join(root, 'scripts/check-source-language.mjs'),
    );
    writeFileSync(join(root, 'packages/core/src/a.ts'), '// plain English\n');
    writeFileSync(join(root, 'packages/core/src/b.ts'), '// also plain\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('exits 0 and states how many files it scanned when nothing is wrong', () => {
    const { status, out } = run();
    expect(status).toBe(0);
    expect(SCANNED.exec(out)?.[1]).toBe('2');
  });

  it('exits 1 naming the line, and still states how many files it scanned, so verify reads a red and not a gate fault', () => {
    writeFileSync(join(root, 'packages/core/src/b.ts'), '// mañana por la tarde\n');
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toContain('packages/core/src/b.ts:1:');
    expect(SCANNED.exec(out)?.[1]).toBe('2');
  });
});
