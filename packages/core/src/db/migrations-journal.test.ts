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

/** Where the two sides live, as a reader of a failure has to type them. */
const MIGRATIONS_REL = 'packages/core/drizzle/migrations';

/**
 * Every migration the directory and the journal disagree about, as the sentence that sends a reader
 * to the fix rather than to a search.
 *
 * Drizzle reads `meta/_journal.json` and never scans the directory, so the two can name different
 * sets and the deploy will not say so. A file no entry names is the silent half: it is present,
 * reviewable and in the diff, and it does not run. Where it only moves rows, no crash, query or log
 * line reveals that afterwards either. An entry whose file is gone is the loud half — the migrator
 * opens every tag it reads — but nothing here looks for it before the container does.
 *
 * `dirEntries` is the raw listing, so what counts as a migration is decided in one place.
 */
function journalDisagreements(dirEntries: string[], tags: string[]): string[] {
  const files = dirEntries.filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -'.sql'.length));
  const registered = new Set(tags);
  const present = new Set(files);
  return [
    ...files
      .filter((tag) => !registered.has(tag))
      .sort()
      .map(
        (tag) =>
          `${tag}.sql is in ${MIGRATIONS_REL}/ and in no meta/_journal.json entry — drizzle applies only what the journal names, so this file will never run: nothing fails on deploy, and where it only moves rows nothing ever will. Register it with a journal entry and a meta/<idx>_snapshot.json, or delete it.`,
      ),
    ...tags
      .filter((tag) => !present.has(tag))
      .sort()
      .map(
        (tag) =>
          `meta/_journal.json names ${tag} and ${MIGRATIONS_REL}/${tag}.sql does not exist — drizzle opens every file the journal names, so the migrator throws on container start when it reaches this entry. Restore the file, or remove the entry.`,
      ),
  ];
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

  it('has a journal and a directory that name the same set of migrations', () => {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    expect(
      journalDisagreements(
        readdirSync(migrationsDir),
        journal.entries.map((e) => e.tag),
      ),
    ).toEqual([]);
  });

  describe('journalDisagreements', () => {
    it('reports a .sql file no journal entry names, by the file name it carries', () => {
      const messages = journalDisagreements(
        ['0289_issue_transition_audit.sql', '0290_closed_means_shipped.sql'],
        ['0289_issue_transition_audit'],
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('0290_closed_means_shipped.sql');
    });

    it('says why an unregistered file is silent rather than counting it', () => {
      const [message] = journalDisagreements(['0290_closed_means_shipped.sql'], []);
      expect(message).toContain('drizzle applies only what the journal names');
      expect(message).toContain('this file will never run');
      expect(message).toContain('where it only moves rows nothing ever will');
    });

    it('reports a journal entry whose file is absent, by its tag', () => {
      const messages = journalDisagreements(['0289_a.sql'], ['0289_a', '0290_ghost']);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('0290_ghost');
    });

    it('reports both directions at once when both are broken', () => {
      expect(journalDisagreements(['0289_a.sql'], ['0290_ghost'])).toHaveLength(2);
    });

    it('reports nothing when the two sides name the same set', () => {
      expect(journalDisagreements(['0288_b.sql', '0289_a.sql'], ['0289_a', '0288_b'])).toEqual([]);
    });

    it('does not report README.md, which is not a migration', () => {
      expect(journalDisagreements(['0289_a.sql', 'README.md'], ['0289_a'])).toEqual([]);
    });

    it('does not report the meta directory, which is not a migration', () => {
      expect(journalDisagreements(['0289_a.sql', 'meta'], ['0289_a'])).toEqual([]);
    });
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
