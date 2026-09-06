import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `date_trunc` over a `timestamptz` must name the zone it floors in.
 *
 * This reads the source rather than running the queries because the failure
 * only appears on a non-UTC database session, and CI runs UTC — an assertion
 * that needs `TZ=Asia/Ho_Chi_Minh` to go red is an assertion CI cannot make,
 * and a green from it would be evidence of nothing.
 */
// cm:edge contract -> packages/core/src/metrics/queries.ts — asserts the `date_trunc` spelling the guard on `bucketTimestamps` requires; the same contract holds for admin/aggregate-routes.ts, pipeline/analytics-routes.ts and usage-records/routes.ts
const FILES = [
  'metrics/queries.ts',
  'admin/aggregate-routes.ts',
  'pipeline/analytics-routes.ts',
  'usage-records/routes.ts',
] as const;

const TOTAL_SITES = 26;

/** The balanced-paren argument list of every `date_trunc(` in `src`. */
function dateTruncCalls(src: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf('date_trunc('); i !== -1; i = src.indexOf('date_trunc(', i + 1)) {
    let depth = 0;
    for (let j = i + 'date_trunc'.length; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          out.push(src.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return out;
}

/** Source with comments removed — prose mentions `date_trunc('week', ...)` and is not a call. */
const read = (rel: string) =>
  readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('bucketed queries floor in UTC, not the session timezone', () => {
  it.each(FILES)('%s names the zone in every date_trunc', (rel) => {
    const calls = dateTruncCalls(read(rel));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !c.includes("AT TIME ZONE 'UTC'"))).toEqual([]);
  });

  it('covers every bucketed site, so adding one is a decision rather than a drift', () => {
    const total = FILES.reduce((n, rel) => n + dateTruncCalls(read(rel)).length, 0);
    expect(total).toBe(TOTAL_SITES);
  });
});
