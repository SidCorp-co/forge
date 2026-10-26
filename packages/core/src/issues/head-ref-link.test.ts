import { describe, expect, it } from 'vitest';
import { descriptionReferences } from './head-ref-link.js';

// adminhub-fe, 2026-10-26: a merge request body saying "pairs with adminhub-api ISS-11" linked
// adminhub-fe's own ISS-11 as delivered, because both projects number their issues ISS-.

const qualifiers = (text: string) =>
  descriptionReferences(text).map((r) => [`${r.prefix}-${r.issSeq}`, r.qualifier]);

describe('descriptionReferences: the project a key is qualified by', () => {
  it('reads the word before a key as a candidate project, in each way it is written', () => {
    expect(
      qualifiers(
        'pairs with adminhub-api ISS-11, adminhub-api#ISS-12, adminhub-api/ISS-13, adminhub-api: ISS-14',
      ),
    ).toEqual([
      ['ISS-11', { kind: 'word', slug: 'adminhub-api' }],
      ['ISS-12', { kind: 'word', slug: 'adminhub-api' }],
      ['ISS-13', { kind: 'word', slug: 'adminhub-api' }],
      ['ISS-14', { kind: 'word', slug: 'adminhub-api' }],
    ]);
  });

  it('reads an issue page link as naming its project outright', () => {
    expect(
      qualifiers('see https://forge.example/projects/AdminHub-API/issues/ISS-11 for the API half'),
    ).toEqual([['ISS-11', { kind: 'url', slug: 'adminhub-api' }]]);
  });

  it('reads no qualifier off a key that opens a line or follows punctuation', () => {
    expect(qualifiers('ISS-3\n(ISS-4) and, ISS-5')).toEqual([
      ['ISS-3', null],
      ['ISS-4', null],
      ['ISS-5', null],
    ]);
  });

  it('takes a path segment of some other URL for a path, never a qualifier', () => {
    expect(qualifiers('https://gitlab.example/acme/adminhub-api/ISS-7')).toEqual([['ISS-7', null]]);
  });
});
