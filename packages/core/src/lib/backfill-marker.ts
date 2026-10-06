import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

// a row whose re-embed fails for a reason other than an outage stays NULL; without a mark it
// stays oldest too, and enough of them fill every batch so nothing behind them is ever retried
const KEY = 'backfillFailedAt';

/** Not marked, or marked long enough ago to be tried again. */
export const backfillDue = (metadata: AnyColumn): SQL =>
  sql`(${metadata}->>${KEY} IS NULL OR (${metadata}->>${KEY})::timestamptz < now() - interval '24 hours')`;

/** Unmarked rows first, so a retried failure never goes ahead of a fresh one. */
export const backfillOrder = (metadata: AnyColumn): SQL => sql`(${metadata}->>${KEY} IS NOT NULL)`;

export const markBackfillFailed = (metadata: AnyColumn): SQL =>
  sql`${metadata} || jsonb_build_object(${KEY}::text, now())`;

export const clearBackfillMark = (metadata: AnyColumn): SQL => sql`${metadata} - ${KEY}::text`;
