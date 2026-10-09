// ISS-464 (REQ-35 BC-10, BC-2, BC-4, BC-12, BC-14): what a picture carried in a draft is refused for,
// before anything is written, and when the assistant's draft must draw one.

import type { DraftPicture } from '@forge/contracts/requirement-pictures';
import { describe, expect, it } from 'vitest';
import { draftPictureRefusals, type Landing, NEW_REQUIREMENT } from './draft-picture.js';

const FLOW: DraftPicture = {
  kind: 'flow',
  content: {
    nodes: [
      { id: 'ask', label: 'Buyer asks' },
      { id: 'paid', label: 'Refund paid' },
    ],
    edges: [{ from: 'ask', to: 'paid' }],
  },
};
const TABLE: DraftPicture = {
  kind: 'example_table',
  content: { rows: [{ input: 'A cart of 3 items', expected: 'Shipping is free' }] },
};

/** A head revision of REQ-7 a new revision r3 lands on. */
const onHead = (kind: Landing['kind'], shows: Landing['shows']): Landing => ({
  key: 'REQ-7',
  revision: 3,
  kind,
  shows,
});

const codes = (r: { code: string; path: string }[]) => r.map((x) => `${x.code} ${x.path}`);

describe("the assistant's draft draws its picture (BC-10)", () => {
  it('refuses a new requirement drafted with no kind and no picture, naming both', () => {
    const [r] = draftPictureRefusals(NEW_REQUIREMENT, {}, true);
    expect(r).toMatchObject({ code: 'REQUIREMENT_PICTURE_NOT_DRAWN', path: '/picture' });
    expect(r?.detail).toContain('names its kind and draws its picture in the same write');
  });

  it('refuses a new requirement drafted with a kind and no picture, naming the picture it takes', () => {
    const [r] = draftPictureRefusals(NEW_REQUIREMENT, { kind: 'rule' }, true);
    expect(r?.code).toBe('REQUIREMENT_PICTURE_NOT_DRAWN');
    expect(r?.detail).toContain('draws an example table (picture kind example_table)');
  });

  it('takes a new requirement that names its kind and draws it', () => {
    expect(draftPictureRefusals(NEW_REQUIREMENT, { kind: 'process', picture: FLOW }, true)).toEqual(
      [],
    );
  });

  it("takes a revision that keeps the head's kind, which carries the head's picture", () => {
    expect(draftPictureRefusals(onHead('process', 'flow'), {}, true)).toEqual([]);
    expect(draftPictureRefusals(onHead('process', 'flow'), { kind: 'process' }, true)).toEqual([]);
  });

  it('refuses a revision whose kind changes and draws nothing: it would show none', () => {
    expect(codes(draftPictureRefusals(onHead('process', 'flow'), { kind: 'rule' }, true))).toEqual([
      'REQUIREMENT_PICTURE_NOT_DRAWN /picture',
    ]);
  });

  it('refuses a revision of a head that shows no picture, unless it draws one', () => {
    expect(codes(draftPictureRefusals(onHead('rule', null), {}, true))).toEqual([
      'REQUIREMENT_PICTURE_NOT_DRAWN /picture',
    ]);
    expect(draftPictureRefusals(onHead('rule', null), { picture: TABLE }, true)).toEqual([]);
  });
});

describe("a person's draft needs no picture (BC-14)", () => {
  it('takes a new requirement and a revision with none', () => {
    expect(draftPictureRefusals(NEW_REQUIREMENT, {}, false)).toEqual([]);
    expect(draftPictureRefusals(onHead('process', 'flow'), { kind: 'rule' }, false)).toEqual([]);
  });
});

describe('a carried picture meets the rules a page picture meets', () => {
  it("refuses a picture of another kind than the requirement's (BC-2)", () => {
    const r = draftPictureRefusals(NEW_REQUIREMENT, { kind: 'rule', picture: FLOW }, false);
    expect(codes(r)).toEqual(['REQUIREMENT_PICTURE_KIND_MISMATCH /picture/kind']);
    expect(r[0]?.detail).toContain('is a rule requirement, whose picture is an example table');
  });

  it("refuses a picture that does not fit the head's kind it keeps", () => {
    expect(
      codes(draftPictureRefusals(onHead('rule', 'example_table'), { picture: FLOW }, true)),
    ).toEqual(['REQUIREMENT_PICTURE_KIND_MISMATCH /picture/kind']);
  });

  it('refuses a picture on a draft that names no kind, saying to name it in the same write', () => {
    const [r] = draftPictureRefusals(NEW_REQUIREMENT, { picture: FLOW }, true);
    expect(r).toMatchObject({ code: 'REQUIREMENT_PICTURE_KIND_MISMATCH', path: '/kind' });
    expect(r?.detail).toContain('name its kind in the same write');
  });

  it("refuses a rule's table row lacking its input or its expected result (BC-4)", () => {
    const table: DraftPicture = {
      kind: 'example_table',
      content: { rows: [{ input: 'A cart of 3 items', expected: ' ' }] },
    };
    expect(
      codes(draftPictureRefusals(NEW_REQUIREMENT, { kind: 'rule', picture: table }, true)),
    ).toEqual(['REQUIREMENT_PICTURE_ROW_INCOMPLETE /picture/content/rows/0']);
  });

  it('refuses a text alternative written blank, and writes one left out from the content (BC-12)', () => {
    const blank = draftPictureRefusals(
      NEW_REQUIREMENT,
      { kind: 'process', picture: { ...FLOW, alt: '  ' } },
      true,
    );
    expect(codes(blank)).toEqual(['REQUIREMENT_PICTURE_ALT_REQUIRED /picture/alt']);
    expect(draftPictureRefusals(NEW_REQUIREMENT, { kind: 'process', picture: FLOW }, true)).toEqual(
      [],
    );
  });
});
