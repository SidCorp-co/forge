// REQ-35 (ISS-459): the guards of a revision's picture. Each is planted with the input it refuses
// and the code it names; a guard that passed everything would leave these red.

import { describe, expect, it } from 'vitest';
import {
  altRefusal,
  kindMismatchRefusal,
  rowRefusals,
  supersededRefusal,
} from './picture-rules.js';

describe('a picture fits its revision kind (REQUIREMENT_PICTURE_KIND_MISMATCH)', () => {
  it.each([
    ['process', 'flow'],
    ['rule', 'example_table'],
    ['screen', 'wireframe'],
    ['report', 'chart'],
  ] as const)('a %s requirement takes a %s', (kind, picture) => {
    expect(kindMismatchRefusal('REQ-1', 1, kind, picture)).toBeNull();
  });

  it('refuses a picture of another kind, naming the one the kind takes in plain words', () => {
    const r = kindMismatchRefusal('REQ-1', 2, 'rule', 'flow');
    expect(r?.code).toBe('REQUIREMENT_PICTURE_KIND_MISMATCH');
    expect(r?.path).toBe('/kind');
    expect(r?.detail).toBe(
      'REQ-1 r2 is a rule requirement, whose picture is an example table, not a flow; draw an example table, or correct its kind first.',
    );
  });

  it('refuses any picture on a revision that names no kind, saying in words to set it first', () => {
    const r = kindMismatchRefusal('REQ-1', 1, null, 'wireframe');
    expect(r?.code).toBe('REQUIREMENT_PICTURE_KIND_MISMATCH');
    expect(r?.detail).toBe(
      'REQ-1 r1 does not say what kind of requirement it is yet, so no picture fits it; set its kind first: a process takes a flow, a rule an example table, a screen a wireframe and a report a sample chart.',
    );
  });

  // ISS-460: the detail is shown on the requirement page's kind field, where a person reads it
  it.each([
    [null, 'flow'],
    ['rule', 'flow'],
    ['process', 'chart'],
    ['screen', 'example_table'],
    ['report', 'wireframe'],
  ] as const)(
    'says a revision of kind %s refusing the %s picture with no route and no wire value',
    (kind, picture) => {
      const detail = kindMismatchRefusal('REQ-1', 1, kind, picture)?.detail ?? '';
      expect(detail).not.toMatch(/PUT|\/revisions\/|\(kind |example_table|…/);
    },
  );
});

describe("a rule's example table (REQUIREMENT_PICTURE_ROW_INCOMPLETE)", () => {
  it('takes rows that each hold an input and an expected result', () => {
    expect(rowRefusals({ rows: [{ input: '3 items', expected: 'free shipping' }] })).toEqual([]);
  });

  it('names each row that lacks either half, and which half', () => {
    const refusals = rowRefusals({
      rows: [
        { input: '3 items', expected: 'free shipping' },
        { input: '1 item' },
        { input: '  ', expected: 'paid shipping' },
        {},
      ],
    });
    expect(refusals.map((r) => [r.code, r.path])).toEqual([
      ['REQUIREMENT_PICTURE_ROW_INCOMPLETE', '/content/rows/1'],
      ['REQUIREMENT_PICTURE_ROW_INCOMPLETE', '/content/rows/2'],
      ['REQUIREMENT_PICTURE_ROW_INCOMPLETE', '/content/rows/3'],
    ]);
    // read whole, as a person reads it: no stray article before either half
    const said = 'each row is an input and the result it is expected to give.';
    expect(refusals.map((r) => r.detail)).toEqual([
      `row 2 of the example table has no expected result; ${said}`,
      `row 3 of the example table has no input; ${said}`,
      `row 4 of the example table has no input and no expected result; ${said}`,
    ]);
  });

  it('refuses a table with no row', () => {
    expect(rowRefusals({ rows: [] }).map((r) => r.path)).toEqual(['/content/rows']);
  });
});

describe('a picture carries a text alternative (REQUIREMENT_PICTURE_ALT_REQUIRED)', () => {
  it.each(['', '   ', '\n'])('refuses %j', (alt) => {
    expect(altRefusal(alt)?.code).toBe('REQUIREMENT_PICTURE_ALT_REQUIRED');
  });

  it('takes a sentence', () => {
    expect(altRefusal('Three orders, shipping free from three items.')).toBeNull();
  });
});

describe('a superseded revision is evidence', () => {
  it('refuses its picture and its kind, pointing at the head', () => {
    const r = supersededRefusal('REQ-1', 1, 'superseded', 2, 'picture');
    expect(r?.code).toBe('REQUIREMENT_REVISION_NOT_CURRENT');
    expect(r?.detail).toContain('write the picture of r2');
  });

  it.each(['draft', 'proposed', 'current'] as const)('takes a %s revision', (state) => {
    expect(supersededRefusal('REQ-1', 1, state, 1, 'kind')).toBeNull();
  });
});
