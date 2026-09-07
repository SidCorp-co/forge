import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bucketIso } from './time-buckets.js';

/**
 * The chokepoint guard on `utcDateTrunc` made enforceable.
 *
 * A bare `date_trunc(unit, ts)` over a `timestamptz` floors in the session
 * `TimeZone`, so it cannot match the UTC boundaries the JS side generates and
 * the series gap-fills to zero with nothing logged. Comparing one against a
 * `timestamptz` is the quieter half: the naive result is coerced through the
 * session zone, moving the cutoff by the offset. Neither shows up on a UTC
 * session, which is what CI runs — so the assertion is made against the
 * source, where it can go red anywhere. The rule is zero-tolerance rather
 * than "names a zone somewhere in the call", because `date_trunc('month',
 * now() AT TIME ZONE 'UTC')` names one and is still wrong — it returns a naive
 * `timestamp`, and the coercion back is what reintroduces the session zone.
 */
// cm:edge contract -> packages/core/src/lib/time-buckets.ts — this is the gate behind that file's `cm:guard`; the scan matches the `date_trunc(` spelling by text, so it keeps holding if the helper is renamed
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
