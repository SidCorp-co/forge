import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const metaDir = fileURLToPath(new URL('../../drizzle/migrations/meta/', import.meta.url));
const journalPath = `${metaDir}_journal.json`;

/** Every `<idx>_snapshot.json` in index order, with the chain links drizzle-kit reads. */
function readSnapshotChain(): Array<{ idx: number; id: string; prevId: string }> {
  return readdirSync(metaDir)
    .filter((f) => f.endsWith('_snapshot.json'))
    .map((f) => {
      const snap = JSON.parse(readFileSync(`${metaDir}${f}`, 'utf8')) as {
        id: string;
        prevId: string;
      };
      return { idx: Number(f.split('_')[0]), id: snap.id, prevId: snap.prevId };
    })
    .sort((a, b) => a.idx - b.idx);
}

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
      // cm:why both indices are in range by the loop bounds — the guard exists only to narrow away `undefined` under noUncheckedIndexedAccess
      if (!prev || !cur) continue;
      if (cur.when <= prev.when && !GRANDFATHERED_IDX.has(cur.idx)) {
        outOfOrder.push(`${cur.tag} (when=${cur.when}) <= ${prev.tag} (when=${prev.when})`);
      }
    }
    expect(outOfOrder).toEqual([]);
  });

  // cm:guard a broken chain does not fail a deploy — it fails `drizzle-kit generate`, so the only symptom is that nobody can author a migration and everyone hand-writes SQL instead. Measured 2026-08-18: `0173` had forked off `0168`, `generate` had been dead long enough that 8 migrations were hand-authored after it, and the forked head snapshot was missing three columns the database already had — so the first `generate` that ever succeeded again would have emitted `ADD COLUMN` for all three and failed on the live database.
  // cm:guard snapshots exist for only 36 of the 182 journal entries, which is FINE and must stay allowed: drizzle-kit chains the snapshot FILES, not the journal, so a hand-authored migration legitimately adds no snapshot. Assert the links between the files that exist — never that a file exists per journal entry.
  it('has an unbroken snapshot chain', () => {
    const chain = readSnapshotChain();
    expect(chain.length).toBeGreaterThan(1);
    // cm:guard one pass, not `.filter().map()` — the index in a chained `map` counts the FILTERED array, so the message named snapshot 0 for a break at 172 and would have sent the next reader to the wrong file.
    const broken = chain
      .slice(1)
      .flatMap((cur, i) =>
        cur.prevId === chain[i]?.id
          ? []
          : [`${cur.idx}_snapshot.prevId does not point at snapshot ${chain[i]?.idx}`],
      );
    expect(broken).toEqual([]);
  });

  // cm:guard the HEAD snapshot is what `drizzle-kit generate` diffs the schema against, so it must belong to a real journal entry. A head that ran ahead of the journal makes generate believe applied work is still pending; one that lags makes it re-emit DDL the database already has.
  it('has a head snapshot that names a journal entry', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number }>;
    };
    const chain = readSnapshotChain();
    const head = chain[chain.length - 1];
    expect(journal.entries.map((e) => e.idx)).toContain(head?.idx);
  });
});
