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
