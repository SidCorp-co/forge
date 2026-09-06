import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The JS bucket keys are floored in UTC; the SQL that produces the keys they
 * are matched against must be too. This reads the source rather than running
 * the queries because the failure only appears on a non-UTC database session,
 * and CI runs UTC — an assertion that needs `TZ=Asia/Ho_Chi_Minh` to go red is
 * an assertion CI cannot make.
 */
// cm:edge contract -> packages/core/src/metrics/queries.ts — asserts the `date_trunc` spelling `bucketTimestamps`' guard requires; the same contract is asserted here for admin/aggregate-routes.ts
const FILES = ['metrics/queries.ts', 'admin/aggregate-routes.ts'] as const;

const BARE = /date_trunc\(\$\{[^}]+\},\s*[A-Za-z_][A-Za-z0-9_.]*\s*\)/g;
const ANCHORED =
  /date_trunc\(\$\{[^}]+\},\s*[A-Za-z_][A-Za-z0-9_.]*\s+AT TIME ZONE 'UTC'\)\s*AT TIME ZONE 'UTC'/g;

const read = (rel: string) => readFileSync(join(import.meta.dirname, '..', rel), 'utf8');

describe('bucketed queries floor in UTC, not the session timezone', () => {
  it.each(FILES)('%s truncates every bucket in UTC', (rel) => {
    const src = read(rel);
    expect(src.match(BARE)).toBeNull();
    expect(src.match(ANCHORED)?.length ?? 0).toBeGreaterThan(0);
  });

  it('every date_trunc that names a bucket column is anchored', () => {
    const total = FILES.reduce((n, rel) => n + (read(rel).match(ANCHORED)?.length ?? 0), 0);
    expect(total).toBe(17);
  });
});
