import { sql } from 'drizzle-orm';

/**
 * First runner release a claim is served to: 0.13.0 dropped the job pool (ddabc1f2b), so no box at or
 * above it parks a job-linked session in its process. A box below it is held `below-floor` by name
 * (`runners/ineligible.ts`), never served.
 */
export const CLAIM_MIN_RUNNER = '0.13.0';

/** `a.b.c` with an optional `-pre-release` or `+build` suffix; the numeric core is what a floor compares. */
const VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Whether a reported runner version is at or above `min` (`a.b.c`); a `-dev.N` / `-rc.N` / `+build` suffix is ignored. */
export function atLeastVersion(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const m = VERSION_SHAPE.exec(version);
  if (!m) return false;
  const a = [Number(m[1]), Number(m[2]), Number(m[3])];
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

export function claimCapableSql(alias: string) {
  const version = sql.raw(`${alias}.agent_version`);
  const floor = sql.raw(`ARRAY[${CLAIM_MIN_RUNNER.split('.').join(',')}]`);
  return sql`(${version} ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$'
    AND string_to_array(split_part(split_part(${version}, '+', 1), '-', 1), '.')::int[] >= ${floor})`;
}

export const CLAIM_CAPABLE_DEVICE = sql`AND EXISTS (
  SELECT 1 FROM devices d WHERE d.id = device_id AND ${claimCapableSql('d')}
)`;
