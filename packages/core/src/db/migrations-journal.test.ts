import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const journalPath = fileURLToPath(
  new URL('../../drizzle/migrations/meta/_journal.json', import.meta.url)
);

// cm:why idx 21/36 predate ISS-807; a `when` may only be rewritten if its migration's DDL is idempotent or proven applied nowhere — neither holds for these, so they stay frozen
const GRANDFATHERED_IDX = new Set([21, 36]);

describe('drizzle migration journal', () => {
  it('has strictly increasing `when` per idx order (new entries only)', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const outOfOrder: string[] = [];
    // cm:edge contract -> packages/core/src/db/migrate.ts — mirrors the migrator's own comparison so a `when` that doesn't clear its predecessor is caught here instead of silently skipped at deploy
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur = entries[i];
      if (cur.when <= prev.when && !GRANDFATHERED_IDX.has(cur.idx)) {
        outOfOrder.push(`${cur.tag} (when=${cur.when}) <= ${prev.tag} (when=${prev.when})`);
      }
    }
    expect(outOfOrder).toEqual([]);
  });
});
