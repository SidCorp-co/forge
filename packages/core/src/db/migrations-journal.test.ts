import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const metaDir = fileURLToPath(new URL('../../drizzle/migrations/meta/', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../drizzle/migrations/', import.meta.url));
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

/**
 * `sql` with the parts that are not executable code removed: block comments, line comments, and
 * single-quoted literals. Dollar-quoted bodies are deliberately KEPT — a `DO $$ ... $$` block is
 * where a hand-authored migration puts its DDL, and blanking it would hide exactly what
 * `containsSchemaDdl` exists to find.
 */
function stripNonCode(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

// cm:guard the modifier group is what this classifier is FOR: 47 of this repo's migrations say `CREATE UNIQUE INDEX`, and a `CREATE\s+INDEX` pattern matches none of them — it reads as a working gate while missing the commonest DDL drizzle-kit emits.
// cm:guard the object list is exactly the top-level keys of a drizzle snapshot, measured on `meta/0239_snapshot.json`: tables, enums, schemas, sequences, roles, policies, views. A function, procedure, trigger, rule, domain or extension appears in NONE of them — `0237_issue_prefix_tombstone.sql` is a bare `CREATE OR REPLACE FUNCTION` and `grep issue_prefix_aliases_immutable` over that snapshot answers 0 — so `db:generate` emits nothing for one and a gate demanding a snapshot for it is a red no command can clear. Add a keyword here only after checking it can appear in a snapshot.
const SCHEMA_DDL =
  /\b(?:CREATE|ALTER|DROP)(?:\s+(?:OR\s+REPLACE|UNIQUE|MATERIALIZED|TEMP|TEMPORARY|UNLOGGED|GLOBAL|LOCAL|RECURSIVE|CONCURRENTLY|IF\s+NOT\s+EXISTS|IF\s+EXISTS))*\s+(?:TABLE|INDEX|TYPE|VIEW|SCHEMA|SEQUENCE|ROLE|POLICY)\b/i;

/** Whether a migration's body changes something a drizzle snapshot records, rather than only rows. */
function containsSchemaDdl(sql: string): boolean {
  return SCHEMA_DDL.test(stripNonCode(sql));
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

  // cm:guard the NEWEST entry is held to the exact arithmetic, not merely to "greater than" — a real timestamp is always greater than the entry before it and still lands below the highest `created_at` in a database that has been migrated from another branch, which is the shape drizzle skips silently and forever (ISS-807)
  it('has a head entry at exactly the previous maximum plus one day', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const head = entries[entries.length - 1];
    const prevMax = Math.max(...entries.slice(0, -1).map((e) => e.when));
    expect(`${head?.tag}: ${head?.when}`).toBe(`${head?.tag}: ${prevMax + 86_400_000}`);
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

  // cm:guard a migration may NOT open or close a transaction of its own: drizzle wraps the whole run
  // in one, so a file's own `COMMIT` ends drizzle's and every migration after it auto-commits.
  // cm:why `0067_unify_runners.sql` did exactly that for 171 migrations, each free to half-apply and
  // still be recorded as applied — found by ISS-1001, whose temp table was dropped under it.
  it('contains no migration that opens or closes a transaction itself', () => {
    // cm:why `BEGIN`/`END` inside `$$ ... $$` are PL/pgSQL block markers, so the scan tracks the
    // dollar quote it is inside rather than reading them as transaction control.
    const offences: string[] = [];
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(`${migrationsDir}${file}`, 'utf8');
      let inBlock = false;
      for (const [i, line] of sql.split('\n').entries()) {
        const text = line.trim();
        const dollars = text.match(/\$[a-z_]*\$/gi)?.length ?? 0;
        if (!text.startsWith('--') && !inBlock) {
          const bare = text.replace(/;$/, '').toUpperCase();
          // cm:why `END` is absent though it commits: it also closes a `CASE`, which three live
          // migrations do on its own line, and a rule needing three waivers is a rule nobody reads.
          if (['BEGIN', 'COMMIT', 'ROLLBACK', 'START TRANSACTION'].includes(bare)) {
            offences.push(`${file}:${i + 1} ${bare}`);
          }
        }
        if (dollars % 2 === 1) inBlock = !inBlock;
      }
    }
    expect(offences).toEqual([]);
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

  // cm:guard the test above admits a head snapshot that LAGS, which is the half of its own cm:guard it cannot see: `0238_drop_body_template` landed hand-authored on 2026-09-14 with no snapshot, and the next `drizzle-kit generate` re-emitted its three statements as a fresh migration — without `IF EXISTS`, so applying it to a migrated database fails. A data-only migration after the head is still fine (0234, 0236, 0237 carry no snapshot and change no schema); only a DDL-bearing one is a lag, and the fix is always `pnpm db:generate` on the merged tree, keeping the snapshot and discarding the emitted `.sql`.
  it('has no DDL-bearing migration after the head snapshot', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const chain = readSnapshotChain();
    const headIdx = chain[chain.length - 1]?.idx ?? -1;
    const lagging = journal.entries
      .filter((e) => e.idx > headIdx)
      .filter((e) => containsSchemaDdl(readFileSync(`${migrationsDir}${e.tag}.sql`, 'utf8')))
      .map(
        (e) =>
          `${e.tag}.sql changes the schema but sits after snapshot ${headIdx} — run \`pnpm db:generate\` on the merged tree, keep meta/<idx>_snapshot.json and discard the .sql it emits`,
      );
    expect(lagging).toEqual([]);
  });

  // cm:guard these cases are the classifier's own evidence, because the case above reads as a working gate whichever way the pattern is wrong — too narrow and it stays green while the rot is there, too wide and it demands a snapshot `db:generate` will not produce. Each row is a form that has actually appeared in `drizzle/migrations/`: the `false` ones are the data shapes a text search misreads, and the objects a drizzle snapshot does not record.
  it.each([
    ['CREATE TABLE "x" ("id" uuid);', true],
    ['CREATE TABLE IF NOT EXISTS "x" ("id" uuid);', true],
    ['CREATE UNIQUE INDEX "x_idx" ON "x" ("id");', true],
    ['CREATE INDEX CONCURRENTLY IF NOT EXISTS "x_idx" ON "x" ("id");', true],
    ['CREATE OR REPLACE VIEW "v" AS SELECT 1;', true],
    ['CREATE MATERIALIZED VIEW "v" AS SELECT 1;', true],
    ['ALTER TABLE "x" ADD COLUMN "y" text;', true],
    ['ALTER TABLE "x" DROP COLUMN "y";', true],
    ['ALTER TYPE "status" ADD VALUE \'new\';', true],
    ['DROP INDEX "x_idx";', true],
    ['CREATE SCHEMA "s";', true],
    ['CREATE SEQUENCE "q";', true],
    ['CREATE EXTENSION IF NOT EXISTS vector;', false],
    ['CREATE TRIGGER "t" AFTER INSERT ON "x" EXECUTE FUNCTION f();', false],
    ['CREATE OR REPLACE FUNCTION "f"() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$;', false],
    ["UPDATE notes SET body = 'DROP TABLE example';", false],
    ['-- DROP TABLE "x" was reverted on 2026-01-01\nUPDATE x SET y = 1;', false],
    ['/* ALTER TABLE "x" */ UPDATE x SET y = 1;', false],
    ["UPDATE projects SET agent_config = agent_config #- '{stateContext}';", false],
    ['DO $$ BEGIN UPDATE x SET y = 1; END $$;', false],
    ['DO $$ BEGIN CREATE INDEX "x_idx" ON "x" ("id"); END $$;', true],
  ])('classifies %j as schema DDL: %s', (sql, isDdl) => {
    expect(containsSchemaDdl(sql)).toBe(isDdl);
  });
});
