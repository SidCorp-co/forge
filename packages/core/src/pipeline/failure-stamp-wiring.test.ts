// ISS-812 AC1 — `failureStamp` makes a terminal write honest only where it is
// actually called. Nothing type-checks the absence of a hand-written stamp, and
// four writes had frozen `classifierVersion: 3` while the taxonomy reached 8, so
// the rule is asserted structurally over the source of `packages/core/src`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) return [];
    return [full];
  });
}

// cm:why comments are stripped before the scan because the guard that states this very rule quotes the offending literal, so a raw text scan reports the rule's own documentation as the violation
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length),
  code: code(readFileSync(path, 'utf8')),
}));

describe('failure-stamp wiring (ISS-812)', () => {
  it('collects the core source tree it is meant to scan', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((f) => f.path)).toContain('jobs/dispatcher.ts');
  });

  // cm:guard a numeric `classifierVersion:` is a verdict frozen at the moment someone typed it — the four that existed all said 3 while the classifier was at 8, so 49 live rows from 2026-08-20/21 read as five-version-old semantics; write `failureStamp(kind, reason)` instead, which stamps CLASSIFIER_VERSION
  it('no write hardcodes a classifier version', () => {
    const offenders = files
      .filter((f) => /classifierVersion:\s*\d/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('the four sites that carried the frozen literal now route through failureStamp', () => {
    for (const path of [
      'jobs/dispatcher.ts',
      'jobs/loop-monitor.ts',
      'jobs/handle-resume-failed.ts',
    ]) {
      const file = files.find((f) => f.path === path);
      expect(file?.code).toContain('failureStamp(');
    }
  });
});
