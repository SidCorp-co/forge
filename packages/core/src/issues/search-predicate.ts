// cm:guard ISS-960 — the ONE place the searchable issue fields are named. `search.ts` and `list-service.ts` both read it, and `issues.identSearch`'s generated expression (db/schema.ts) is generated over the same four columns; a field added to one and not the others answers confidently and wrongly, which is the defect this module was cut for.
// cm:edge lockstep -> packages/core/src/db/schema.ts — `ISSUE_SEARCH_FIELDS` and the `identSearch` generated column must name the same columns, and widening that column needs a migration that rewrites it

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

// cm:why no `ESCAPE '\\'` clause anywhere below: backslash is already Postgres' default LIKE escape, so the clause the old hand-written SQL carried was a no-op, and stating it on some arms and not others is what makes two of these look like different predicates
/** Escape ILIKE wildcard metacharacters so user input can't inject patterns. */
export function buildIlikePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}

/**
 * The search predicate: a literal substring of any searchable field, or the
 * identifier arm (`cascade` finds `runs-cascade.ts`) over the generated
 * `ident_search` column, which covers the same four fields.
 */
export function buildIssueSearchCondition(term: string): SQL {
  const pattern = buildIlikePattern(term);
  // biome-ignore lint/style/noNonNullAssertion: or() over a non-empty list is always defined
  return or(
    ...ISSUE_SEARCH_FIELDS.map((f) => ilike(columnOf[f], pattern)),
    sql`${issues.identSearch} @@ ${identifierTsQuery(term)}`,
  )!;
}

/**
 * Which fields a row matched, from a row that already carries them — the REST
 * search route selects whole issues, so this costs no extra read there.
 *
 * The identifier arm can match a row no field matches literally (a camelCase
 * or `-`-split token), so `[]` is a legal answer and means "matched on the
 * identifier split rather than on a substring".
 */
export function issueSearchMatchedFields(
  term: string,
  row: Partial<Record<IssueSearchField, string | null>>,
): IssueSearchField[] {
  const needle = term.toLowerCase();
  return ISSUE_SEARCH_FIELDS.filter((f) => (row[f] ?? '').toLowerCase().includes(needle));
}

/**
 * The same answer as `issueSearchMatchedFields`, computed by Postgres, for the
 * light browse projection whose whole point (ISS-562) is never to read `plan`
 * or `acceptanceCriteria` off disk into the app.
 */
export function matchedSearchFieldsSql(term: string): SQL<IssueSearchField[]> {
  const pattern = buildIlikePattern(term);
  const arms = ISSUE_SEARCH_FIELDS.map(
    (f) => sql`case when ${columnOf[f]} ILIKE ${pattern} then ${f}::text end`,
  );
  return sql<IssueSearchField[]>`array_remove(array[${sql.join(arms, sql`, `)}], null)`;
}
