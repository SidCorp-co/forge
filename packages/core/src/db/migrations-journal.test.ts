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

const SCHEMA_DDL =
  /\b(?:CREATE|ALTER|DROP)(?:\s+(?:OR\s+REPLACE|UNIQUE|MATERIALIZED|TEMP|TEMPORARY|UNLOGGED|GLOBAL|LOCAL|RECURSIVE|CONCURRENTLY|IF\s+NOT\s+EXISTS|IF\s+EXISTS))*\s+(?:TABLE|INDEX|TYPE|VIEW|SCHEMA|SEQUENCE|ROLE|POLICY)\b/i;

/** Whether a migration's body changes something a drizzle snapshot records, rather than only rows. */
function containsSchemaDdl(sql: string): boolean {
  return SCHEMA_DDL.test(stripNonCode(sql));
}

/**
 * How far above the journal's maximum a new head `when` may sit, in days.
 *
 * One day is the ordinary value and what a lone branch should take. More than one is for clearing
 * a sibling branch that has already claimed the day above you — see the guard on the head-entry
 * test. The bound exists so the number stays derived from the journal: a value 400 days out is
 * indistinguishable from a typo, and it pushes the floor that far for everyone who follows.
 */
const MAX_DAYS_AHEAD = 30;

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
      if (!prev || !cur) continue;
      if (cur.when <= prev.when && !GRANDFATHERED_IDX.has(cur.idx)) {
        outOfOrder.push(`${cur.tag} (when=${cur.when}) <= ${prev.tag} (when=${prev.when})`);
      }
    }
    expect(outOfOrder).toEqual([]);
  });

  it('has a head entry that is a whole number of days strictly above the previous maximum', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const head = entries[entries.length - 1];
    const prevMax = Math.max(...entries.slice(0, -1).map((e) => e.when));
    const ahead = (head?.when ?? 0) - prevMax;
    const days = ahead / 86_400_000;
    // One `expect` per property, each naming the head tag, so a red says which rule was broken and
    // on which entry rather than printing two large integers and leaving the reader to subtract.
    expect(`${head?.tag}: ahead by ${days} day(s)`).toBe(
      `${head?.tag}: ahead by ${Math.round(days)} day(s)`,
    );
    expect({ tag: head?.tag, clearsPreviousMaximum: ahead >= 86_400_000 }).toEqual({
      tag: head?.tag,
      clearsPreviousMaximum: true,
    });
    expect({ tag: head?.tag, withinBound: days <= MAX_DAYS_AHEAD }).toEqual({
      tag: head?.tag,
      withinBound: true,
    });
  });

  it('has an unbroken snapshot chain', () => {
    const chain = readSnapshotChain();
    expect(chain.length).toBeGreaterThan(1);
    const broken = chain
      .slice(1)
      .flatMap((cur, i) =>
        cur.prevId === chain[i]?.id
          ? []
          : [`${cur.idx}_snapshot.prevId does not point at snapshot ${chain[i]?.idx}`],
      );
    expect(broken).toEqual([]);
  });

  it('contains no migration that opens or closes a transaction itself', () => {
    const offences: string[] = [];
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(`${migrationsDir}${file}`, 'utf8');
      let inBlock = false;
      for (const [i, line] of sql.split('\n').entries()) {
        const text = line.trim();
        // Digits are legal in a dollar-quote tag and `[a-z_]*` could not see one, so a block
        // opened as `$iss1048$` never toggled `inBlock` and its PL/pgSQL `BEGIN` was reported as
        // transaction control — a refusal naming the wrong thing, on a migration doing nothing wrong.
        const dollars = text.match(/\$[a-z_][a-z0-9_]*\$|\$\$/gi)?.length ?? 0;
        if (!text.startsWith('--') && !inBlock) {
          const bare = text.replace(/;$/, '').toUpperCase();
          if (['BEGIN', 'COMMIT', 'ROLLBACK', 'START TRANSACTION'].includes(bare)) {
            offences.push(`${file}:${i + 1} ${bare}`);
          }
        }
        if (dollars % 2 === 1) inBlock = !inBlock;
      }
    }
    expect(offences).toEqual([]);
  });

  it('has a head snapshot that names a journal entry', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ idx: number }>;
    };
    const chain = readSnapshotChain();
    const head = chain[chain.length - 1];
    expect(journal.entries.map((e) => e.idx)).toContain(head?.idx);
  });

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
