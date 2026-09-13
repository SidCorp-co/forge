/**
 * ISS-994 — the staged lane's soft-skip resolver was deleted by ISS-897, and
 * for four months its five identifiers went on being named in prose as though
 * something still walked them: `apply-transition.ts` described the resolver
 * passing `skip` while walking `STAGE_FORWARD`, and `resolve.ts` warned a
 * reader off a map that does not exist.
 *
 * A behaviour test cannot see that. Only a source scan can say that the one
 * place naming them is the guard that records their deletion.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

const DELETED = [
  'STAGE_FORWARD',
  'SKIPPABLE_STAGES',
  'MAX_SKIP_CHAIN',
  'resolveSkipTarget',
  'validateStatesConfig',
] as const;

/** The guard that records the deletion, and the only file allowed to name them. */
const THE_GUARD = 'pipeline/state-machine.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (full.endsWith('soft-skip-stays-deleted.test.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('the soft-skip resolver stays deleted (ISS-994)', () => {
  const files = sourceFiles(SRC).map((f) => ({
    path: relative(SRC, f),
    text: readFileSync(f, 'utf8'),
  }));

  it('scans a source tree it actually found', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const identifier of DELETED) {
    it(`names \`${identifier}\` in the deletion guard and nowhere else`, () => {
      const naming = files.filter((f) => f.text.includes(identifier)).map((f) => f.path);
      expect(naming).toEqual([THE_GUARD]);
    });
  }
});
