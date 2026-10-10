// What every alert query reads into, before `alert-queries.ts` joins on when its level changed
// (ISS-652), and the two helpers each query shares: the entity cap and the oldest instant.

import type { AdminAlert } from './types.js';

/** An alert as its query reads it, before the recorded change time is joined on. */
export type AlertReading = Omit<AdminAlert, 'changedAt'>;

/** At most this many entities are named under one alert. */
export const ENTITY_LIMIT = 20;

/** A timestamp as postgres-js hands it back: a string from raw SQL, a Date from the query builder. */
export type PgTimestamp = string | Date;

/** The oldest of the instants given, as ISO, or null when none is readable. */
export function oldestIso(values: Array<PgTimestamp | null>): string | null {
  let oldest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}
