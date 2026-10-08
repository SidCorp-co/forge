import { asc, type SQL, sql } from 'drizzle-orm';
import { issues } from '../db/schema.js';

export function oldestMergeFirst(): [SQL, SQL] {
  return [sql`${issues.mergedAt} ASC NULLS LAST`, asc(issues.id)];
}
