/** What the maintained indexes share at the SQL layer (ISS-1336): the executor, and id lists postgres-js can bind. */

import { type SQL, sql } from 'drizzle-orm';
import type { db } from '../../db/client.js';
import { type IssueStatus, issueStatuses } from '../../db/schema.js';

/** What `forge next` calls takeable: the statuses a run may claim work from. */
export const TAKEABLE_STATUSES: IssueStatus[] = ['open', 'confirmed', 'approved', 'reopen'].filter(
  (s): s is IssueStatus => (issueStatuses as readonly string[]).includes(s),
);

/** What `forge alike` calls open: everything the tracker has not settled. */
export const UNSETTLED_STATUSES: IssueStatus[] = issueStatuses.filter(
  (s) => s !== 'closed' && s !== 'dropped',
);

export type IndexExecutor = Pick<typeof db, 'execute'>;

export const uuidArray = (ids: readonly string[]): SQL =>
  ids.length === 0
    ? sql`'{}'::uuid[]`
    : sql`ARRAY[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]::uuid[]`;

export const uuidList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export const textList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

export type Row = Record<string, unknown>;

/** `db.execute` answers a row list; this is the one place that says so to the type checker. */
export async function rowsOf(executor: IndexExecutor, query: SQL): Promise<Row[]> {
  return (await executor.execute(query)) as unknown as Row[];
}
