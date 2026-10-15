import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ISS-1133 — a job reaches a run through `jobs/admit.ts:admitJob` alone, which locks the run row
 * and refuses a run no longer open in the insert's own transaction. An insert written anywhere else
 * can land a live job under a run a close just ended, so this reads every source file for one.
 */
const SRC = join(import.meta.dirname, '..');
const DOOR = 'jobs/admit.ts';
const INSERT = /\.insert\(\s*jobs\s*\)|INSERT\s+INTO\s+jobs\b/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('the one door a job reaches a run by', () => {
  it('no source file but jobs/admit.ts inserts a job', () => {
    const elsewhere = sources(SRC)
      .filter((path) => INSERT.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
      .filter((path) => path !== DOOR);
    expect(elsewhere).toEqual([]);
  });

  it('jobs/admit.ts does insert one, so the scan above can see an insert', () => {
    expect(INSERT.test(readFileSync(join(SRC, DOOR), 'utf8'))).toBe(true);
  });
});
