import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const journalPath = fileURLToPath(
  new URL('../../drizzle/migrations/meta/_journal.json', import.meta.url)
);

// Pre-existing violations from long-applied migrations, grandfathered like
// .forge/codemap-baseline.json — every environment already recorded these
// `when` values years ago, so rewriting them would not change any live
// database's applied set. New entries must not add to this list.
const GRANDFATHERED_IDX = new Set([21, 36]);

describe('drizzle migration journal', () => {
  it('has strictly increasing `when` per idx order (new entries only)', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const outOfOrder: string[] = [];
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur = entries[i];
      if (cur.when <= prev.when && !GRANDFATHERED_IDX.has(cur.idx)) {
        outOfOrder.push(`${cur.tag} (when=${cur.when}) <= ${prev.tag} (when=${prev.when})`);
      }
    }
    // cm:guard the postgres-js migrator applies a migration only when its
    // `when` exceeds the max `created_at` already recorded in
    // drizzle.__drizzle_migrations — a non-increasing `when` is silently
    // skipped forever, not an error (ISS-807 live 500 on beta)
    expect(outOfOrder).toEqual([]);
  });
});
