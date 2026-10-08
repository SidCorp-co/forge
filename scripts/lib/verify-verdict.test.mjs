// @gate-input whole-tree — it runs a checker over a fixture checkout, and reads the one that stands here.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verdictOf } from './verify-verdict.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = { label: 'c', scanned: /^c: (\d+) file\(s\) scanned/m };
const CRASH =
  'file:///x/check.mjs:3\n  throw new Error("boom");\n\nError: boom\n\nNode.js v24.21.0\n';
const verdict = (status, out, more = {}) => verdictOf({ ...check, ...more }, status, out, 'main');

describe('what a check earns from how it ended', () => {
  it('is green on exit 0 with its count, red on exit 1 with its count', () => {
    expect(verdict(0, 'c: 4 file(s) scanned')).toMatchObject({ code: 0, files: 4 });
    expect(verdict(1, 'c: 4 file(s) scanned\nbad')).toMatchObject({ code: 1, files: 4 });
  });

  it('is red, with its own output, when a checker exits 1 and prints no count', () => {
    const out = 'check-c: 2 write(s) outside the owner:\n  a.ts:3\n';
    const row = verdict(1, out);
    expect(row).toMatchObject({ code: 1, out });
    expect(row.why).toBeUndefined();
    expect(row.files).toBeUndefined();
  });

  it('still refuses an exit 0 with no count, which proves nothing ran', () => {
    expect(verdict(0, 'all fine')).toMatchObject({ code: 2, why: /no file count/ });
  });

  it('still refuses a checker that crashed, though Node exits 1 for that too', () => {
    expect(verdict(1, CRASH)).toMatchObject({ code: 2, why: /no file count/ });
  });

  it('refuses a status that is neither a pass nor the checker saying it failed', () => {
    for (const status of [null, 3, 127, 137]) expect(verdict(status, 'no count').code).toBe(2);
  });

  it('keeps a blocked check blocked and a zero scope refused unless it may be empty', () => {
    expect(verdict(2, 'cannot run')).toMatchObject({ code: 2, condition: 'blocked' });
    expect(verdict(0, 'c: 0 file(s) scanned')).toMatchObject({ code: 2, why: /scanned 0 files/ });
    expect(verdict(0, 'c: 0 file(s) scanned', { scopeMayBeEmpty: true })).toMatchObject({
      code: 0,
      files: 0,
      note: 'no diff against main — nothing to scope',
    });
  });
});

describe('a checker of this repository that fails without a count', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'verify-verdict-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(
      join(SCRIPTS, 'check-merged-at-writers.mjs'),
      join(root, 'scripts/check-merged-at-writers.mjs'),
    );
    mkdirSync(join(root, 'packages/core/src/issues'), { recursive: true });
    mkdirSync(join(root, 'packages/web-v2/src'), { recursive: true });
    writeFileSync(join(root, 'packages/core/src/issues/merge-record.ts'), 'export {};\n');
    writeFileSync(
      join(root, 'packages/core/src/planted.ts'),
      'db.update(issues).set({ mergedAt: new Date() });\n',
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads exit 1 through the verdict, as the checker says it, not as a gate fault', () => {
    const ran = spawnSync('node', ['scripts/check-merged-at-writers.mjs', '--all'], {
      cwd: root,
      encoding: 'utf8',
    });
    const out = `${ran.stdout}${ran.stderr}`;
    const scanned = /^merged-at-writers: (\d+) file\(s\) scanned/m;
    expect(ran.status).toBe(1);
    expect(out).toContain('planted.ts');
    expect(
      verdictOf({ label: 'merged-at-writers', scanned }, ran.status, out, 'main'),
    ).toMatchObject({ code: 1, out });
  });
});
