import { sql } from 'drizzle-orm';

/** First runner release whose claim carries the master's `--agent` name. */
export const AGENT_NAMING_MIN_RUNNER = '0.11.0';

/** Whether a reported runner version is at or above `min` (`a.b.c`). */
export function atLeastVersion(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  if (a.length !== 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

export function claimCapableSql(alias: string) {
  const version = sql.raw(`${alias}.agent_version`);
  const floor = sql.raw(`ARRAY[${AGENT_NAMING_MIN_RUNNER.split('.').join(',')}]`);
  return sql`${version} ~ '^[0-9]+\.[0-9]+\.[0-9]+$'
    AND string_to_array(${version}, '.')::int[] >= ${floor}`;
}

export const CLAIM_CAPABLE_DEVICE = sql`AND EXISTS (
  SELECT 1 FROM devices d WHERE d.id = device_id AND ${claimCapableSql('d')}
)`;
