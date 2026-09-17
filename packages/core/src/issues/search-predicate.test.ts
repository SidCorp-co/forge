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

// cm:why what this answers for a given row is asserted against a real Postgres in `tests/integration/issue-search-matched-fields-e2e.test.ts`, never here: the claim is that the array agrees with what ILIKE did, and a mock of ILIKE agrees with itself whatever it is told (ISS-1016). What is left here is the shape — the arms and their order — which is the part a reader of this file can check.
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
