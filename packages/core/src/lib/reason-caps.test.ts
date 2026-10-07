// C4-5: a reason, note or why field's cap is one of the named bounds in `@forge/contracts/comments`
// (REASON_TEXT_MAX and the shorter ones beside it, each priced there), never a number written at
// the field: 55 caps once read as seven literals, ten of them restating REASON_TEXT_MAX's value.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = resolve(import.meta.dirname, '../../..');
const ROOTS = ['core/src', 'contracts/src'].map((r) => join(PACKAGES, r));

/** A reason/note/why string field and its chain of calls, up to the next field. */
const FIELD =
  /\b(?:reason|note|why)\w*\s*:\s*z\s*\.string\(\)((?:\.\w+\((?:[^()]|\([^()]*\))*\))*)/g;
const LITERAL_MAX = /\.max\(\s*[0-9]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Every literal cap on a reason/note/why field in `text`, as `line: field`. */
function literalReasonCaps(text: string): string[] {
  return [...text.matchAll(FIELD)].flatMap((m) =>
    LITERAL_MAX.test(m[1] ?? '')
      ? [`${text.slice(0, m.index).split('\n').length}: ${m[0].split('(')[0]}`]
      : [],
  );
}

describe('a reason, note or why cap', () => {
  it('is caught when written as a number at the field', () => {
    expect(
      literalReasonCaps('const s = z.object({ reason: z.string().trim().max(500) });'),
    ).toEqual(['1: reason: z.string']);
    expect(
      literalReasonCaps('const s = { note: z.string().min(1).max(REASON_LINE_MAX) };'),
    ).toEqual([]);
    expect(literalReasonCaps('z.array(z.object({ why: z.string().min(1) })).max(10)')).toEqual([]);
  });

  it('is a named bound everywhere in core and contracts', () => {
    const found = ROOTS.flatMap((root) =>
      sources(root).flatMap((file) =>
        literalReasonCaps(readFileSync(file, 'utf8')).map(
          (hit) => `${relative(PACKAGES, file)}:${hit}`,
        ),
      ),
    );
    expect(
      found,
      'name the cap from @forge/contracts/comments (REASON_TEXT_MAX, REASON_PARAGRAPH_MAX, REASON_NOTE_MAX, REASON_SENTENCE_MAX, REASON_LINE_MAX), or price a new one there',
    ).toEqual([]);
  });
});
