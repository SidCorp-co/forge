import { describe, expect, it } from 'vitest';
import {
  buildIlikePattern,
  ISSUE_SEARCH_FIELDS,
  issueSearchMatchedFields,
} from './search-predicate.js';

describe('buildIlikePattern', () => {
  it('wraps plain text with %', () => {
    expect(buildIlikePattern('hello')).toBe('%hello%');
  });

  it('escapes % and _ characters', () => {
    expect(buildIlikePattern('100%_done')).toBe('%100\\%\\_done%');
  });

  it('escapes backslashes', () => {
    expect(buildIlikePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('the searchable field set (ISS-960)', () => {
  it('is the four text fields an issue carries', () => {
    expect([...ISSUE_SEARCH_FIELDS]).toEqual([
      'title',
      'description',
      'plan',
      'acceptanceCriteria',
    ]);
  });
});

describe('issueSearchMatchedFields', () => {
  const row = {
    title: 'Kernel audit',
    description: null,
    plan: 'Prove FR-05~2 on every flip.',
    acceptanceCriteria: '1. FR-05~2 holds.',
  };

  it('names every field carrying the term, in field order', () => {
    expect(issueSearchMatchedFields('FR-05~2', row)).toEqual(['plan', 'acceptanceCriteria']);
  });

  it('matches case-insensitively, as ILIKE does', () => {
    expect(issueSearchMatchedFields('kernel', row)).toEqual(['title']);
  });

  it('treats a null field as carrying nothing', () => {
    expect(issueSearchMatchedFields('audit', { ...row, title: null })).toEqual([]);
  });

  it('returns [] when only the identifier arm could have matched', () => {
    expect(issueSearchMatchedFields('kernelaudit', row)).toEqual([]);
  });
});
