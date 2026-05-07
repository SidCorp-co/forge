import { type SQL, asc, desc, sql } from 'drizzle-orm';
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

export function buildIssueOrderBy(sort: IssueSort): SQL {
  switch (sort) {
    case 'createdAt:asc':
      return asc(issues.createdAt);
    case 'updatedAt:desc':
      return desc(issues.updatedAt);
    case 'updatedAt:asc':
      return asc(issues.updatedAt);
    case 'priority:asc':
      return sql`${priorityRank} ASC`;
    case 'priority:desc':
      return sql`${priorityRank} DESC`;
    default:
      return desc(issues.createdAt);
  }
}
