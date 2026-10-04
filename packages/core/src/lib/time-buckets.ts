import { type SQL, sql } from 'drizzle-orm';

export function utcDateTrunc(unit: SQL | string, column: SQL): SQL {
  return sql`date_trunc(${unit}, ${column} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

export function utcDayText(column: SQL): SQL {
  return sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
}

export function bucketIso(x: unknown): string {
  if (x instanceof Date) return x.toISOString();
  return new Date(x as string).toISOString();
}

export type BucketUnit = 'hour' | 'day' | 'week';

export function bucketStepMs(unit: BucketUnit): number {
  if (unit === 'hour') return 3_600_000;
  if (unit === 'day') return 86_400_000;
  return 7 * 86_400_000;
}

/** Dense, oldest→newest UTC bucket-start boundaries for `count` buckets of
 *  `unit`, ending at the bucket containing `now`. Week buckets floor to UTC
 *  Monday to match `utcDateTrunc('week', ...)`. */
export function bucketBoundaries(unit: BucketUnit, count: number, now: Date): string[] {
  const end = new Date(now);
  end.setUTCMilliseconds(0);
  end.setUTCSeconds(0);
  end.setUTCMinutes(0);
  if (unit !== 'hour') end.setUTCHours(0);
  if (unit === 'week') {
    const isoDay = (end.getUTCDay() + 6) % 7;
    end.setUTCDate(end.getUTCDate() - isoDay);
  }
  const step = bucketStepMs(unit);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(new Date(end.getTime() - i * step).toISOString());
  return out;
}
