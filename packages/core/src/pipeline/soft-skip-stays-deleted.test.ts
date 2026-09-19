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
    it(`names \`${identifier}\` nowhere in the tree`, () => {
      const naming = files.filter((f) => f.text.includes(identifier)).map((f) => f.path);
      expect(naming).toEqual([]);
    });
  }
});
