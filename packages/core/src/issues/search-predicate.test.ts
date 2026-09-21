import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  buildIlikePattern,
  ISSUE_SEARCH_FIELDS,
  matchedSearchFieldsSql,
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

describe('matchedSearchFieldsSql', () => {
  const rendered = (term: string) => new PgDialect().sqlToQuery(matchedSearchFieldsSql(term));

  it('names the fields in ISSUE_SEARCH_FIELDS order', () => {
    const { params } = rendered('kernel');
    const named = params.filter((p): p is string =>
      (ISSUE_SEARCH_FIELDS as readonly string[]).includes(String(p)),
    );
    expect(named).toEqual([...ISSUE_SEARCH_FIELDS]);
  });

  it('carries the escaped pattern, so a wildcard in the term stays literal', () => {
    expect(rendered('100%_done').params).toContain('%100\\%\\_done%');
  });
});
