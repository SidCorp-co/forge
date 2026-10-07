import { asc, desc, type SQL, sql } from 'drizzle-orm';
import { issues } from '../db/schema.js';

export const issueSortValues = [
  'createdAt:desc',
  'createdAt:asc',
  'updatedAt:desc',
  'updatedAt:asc',
  'priority:asc',
  'priority:desc',
] as const;

export type IssueSort = (typeof issueSortValues)[number];

// priority is a text enum; alpha-sort would put 'critical' < 'high', which is
// misleading. Map to numeric ranks so :asc means most-urgent first.
const priorityRank = sql`CASE ${issues.priority}
  WHEN 'critical' THEN 1
  WHEN 'high' THEN 2
  WHEN 'medium' THEN 3
  WHEN 'low' THEN 4
  WHEN 'none' THEN 5
  ELSE 6 END`;

// Many rows share a created_at (a breakdown files its issues in one statement), so every order ends
// on the issue key and then the id: a total order, so a page read at an offset never skips or
// repeats a row between reads, and ties resolve in key order.
const TIEBREAK = [asc(issues.issSeq), asc(issues.id)];

const leadingOrder: Record<IssueSort, SQL> = {
  'createdAt:desc': desc(issues.createdAt),
  'createdAt:asc': asc(issues.createdAt),
  'updatedAt:desc': desc(issues.updatedAt),
  'updatedAt:asc': asc(issues.updatedAt),
  'priority:asc': sql`${priorityRank} ASC`,
  'priority:desc': sql`${priorityRank} DESC`,
};

export function buildIssueOrderBy(sort: IssueSort): SQL[] {
  return [leadingOrder[sort], ...TIEBREAK];
}
