import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bucketIso } from './time-buckets.js';

const SRC_ROOT = join(import.meta.dirname, '..');

/** The one file allowed to spell `date_trunc(` at all. */
const CHOKEPOINT = join('lib', 'time-buckets.ts');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Source with comments removed — prose quotes `date_trunc('week', ...)` and is not a call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*\/\/.*$/gm, '');
}

/** The balanced-paren argument list of every `date_trunc(` in `src`. */
function dateTruncCalls(src: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf('date_trunc('); i !== -1; i = src.indexOf('date_trunc(', i + 1)) {
    let depth = 0;
    for (let j = i + 'date_trunc'.length; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          out.push(src.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return out;
}

describe('bucketIso', () => {
  it('normalises the driver Date and its string form to the same ISO key', () => {
    const iso = '2026-09-07T00:00:00.000Z';
    expect(bucketIso(new Date(iso))).toBe(iso);
    expect(bucketIso(iso)).toBe(iso);
  });
});

describe('no bare date_trunc escapes the chokepoint', () => {
  const scanned = sourceFiles(SRC_ROOT).filter((p) => !p.endsWith(CHOKEPOINT));

  it('reads a source tree at all, so an empty scan cannot pass as a clean one', () => {
    expect(scanned.length).toBeGreaterThan(300);
  });

  it('no source file outside time-buckets.ts spells date_trunc at all', () => {
    const offenders = scanned.flatMap((p) =>
      dateTruncCalls(stripComments(readFileSync(p, 'utf8'))).map(
        (call) => `${p.slice(SRC_ROOT.length + 1)}: ${call}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
