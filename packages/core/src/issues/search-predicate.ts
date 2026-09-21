import { ilike, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { issues } from '../db/schema.js';
import { identifierTsQuery } from '../db/schema-types.js';

export const ISSUE_SEARCH_FIELDS = ['title', 'description', 'plan', 'acceptanceCriteria'] as const;

export type IssueSearchField = (typeof ISSUE_SEARCH_FIELDS)[number];

const columnOf: Record<IssueSearchField, AnyPgColumn> = {
  title: issues.title,
  description: issues.description,
  plan: issues.plan,
  acceptanceCriteria: issues.acceptanceCriteria,
};

/** Escape ILIKE wildcard metacharacters so user input can't inject patterns. */
export function buildIlikePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}

export function buildIssueSearchCondition(term: string): SQL {
  const pattern = buildIlikePattern(term);
  // biome-ignore lint/style/noNonNullAssertion: or() over a non-empty list is always defined
  return or(
    ...ISSUE_SEARCH_FIELDS.map((f) => ilike(columnOf[f], pattern)),
    sql`${issues.identSearch} @@ ${identifierTsQuery(term)}`,
  )!;
}

export function matchedSearchFieldsSql(term: string): SQL<IssueSearchField[]> {
  const pattern = buildIlikePattern(term);
  const arms = ISSUE_SEARCH_FIELDS.map(
    (f) => sql`case when ${columnOf[f]} ILIKE ${pattern} then ${f}::text end`,
  );
  return sql<IssueSearchField[]>`array_remove(array[${sql.join(arms, sql`, `)}], null)`;
}
