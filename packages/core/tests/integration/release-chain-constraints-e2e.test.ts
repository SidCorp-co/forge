/**
 * ISS-1311 / ADR 0003 — `projects_release_chain_chk` in the runtime that enforces it.
 *
 * `releaseChainSchema` is a TypeScript annotation Postgres never sees, and this table is written by
 * raw SQL in migrations, by the MCP tools, by the REST route and by any hand at a psql prompt. The
 * shape rule therefore lives in BOTH places, and this file is the half that proves the database's
 * copy: every clause of the CHECK planted with the one value it exists to refuse, and the refusal
 * read back BY CONSTRAINT NAME rather than by "the insert threw".
 *
 * A clause with no case here is a clause that could be deleted from the function without anything
 * going red, which is why each one is listed separately even where two look alike.
 *
 * The unit-level half — the same rule, with the refusal codes a caller sees — is
 * `src/projects/release-chain.test.ts`.
 */

import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Ground,
  ground,
  type PreMigrationGround,
  plantProject,
  preMigrationGround,
  runForward,
  writeChain,
} from './release-chain-migration-ground.js';

let groundDb: PreMigrationGround;
let db: Awaited<ReturnType<PreMigrationGround['fresh']>>;
let g: Ground;
let subject: string;

/** One migrated database for the whole file: every case writes to the same row and rolls nothing. */
beforeAll(async () => {
  groundDb = await preMigrationGround();
  db = await groundDb.fresh();
  g = await ground(db.sql);
  const planted = await plantProject(db.sql, g, {
    slug: 'chain-under-the-check',
    model: 'none',
    base: 'main',
  });
  subject = planted.id;
  await runForward(db.sql);
}, 300_000);

afterAll(async () => {
  await db?.drop();
  await groundDb?.stop();
});

/**
 * Write a chain and report what the database said — the constraint's own name, or `null` where it
 * took the value. A case asserting `null` is asserting the CHECK is not too tight.
 */
async function refusal(sql: Sql, chain: unknown): Promise<string | null> {
  try {
    await writeChain(sql, subject, chain);
    return null;
  } catch (err) {
    const e = err as unknown as {
      constraint_name?: string;
      message?: string;
      cause?: { constraint_name?: string };
    };
    // The NAME, never "it threw": a NOT NULL or a foreign key refusing the same row would read as
    // this CHECK holding long after the CHECK had been dropped.
    return e.constraint_name ?? e.cause?.constraint_name ?? e.message ?? 'unknown';
  }
}

const CHK = 'projects_release_chain_chk';

describe('projects_release_chain_chk — the shapes Postgres takes', () => {
  it('takes an empty chain', async () => {
    expect(await refusal(db.sql, [])).toBeNull();
  });

  it('takes a chain of one with no crossing', async () => {
    expect(await refusal(db.sql, [{ branch: 'main' }])).toBeNull();
  });

  it('takes a chain of two whose second entry declares its crossing', async () => {
    expect(
      await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: 'merge-branch' }]),
    ).toBeNull();
  });

  it('takes a cherry-pick crossing', async () => {
    expect(
      await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: 'cherry-pick' }]),
    ).toBeNull();
  });

  it('takes a chain of three, which the enum it replaced could not spell', async () => {
    expect(
      await refusal(db.sql, [
        { branch: 'dev' },
        { branch: 'stg', from: 'merge-branch' },
        { branch: 'main', from: 'cherry-pick' },
      ]),
    ).toBeNull();
  });

  it('takes a chain of exactly eight, the length the function names', async () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      i === 0 ? { branch: `b${i}` } : { branch: `b${i}`, from: 'merge-branch' },
    );
    expect(await refusal(db.sql, eight)).toBeNull();
  });
});

describe('projects_release_chain_chk — one case per clause it refuses', () => {
  it('refuses a value that is not an array, by name', async () => {
    expect(await refusal(db.sql, { branch: 'main' })).toBe(CHK);
    expect(await refusal(db.sql, 'main')).toBe(CHK);
  });

  it('refuses a json null, which is not the same value as no chain', async () => {
    expect(await refusal(db.sql, null)).toBe(CHK);
  });

  it('refuses a chain of nine, one past the length the function names', async () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
      i === 0 ? { branch: `b${i}` } : { branch: `b${i}`, from: 'merge-branch' },
    );
    expect(await refusal(db.sql, nine)).toBe(CHK);
  });

  it('refuses an entry that is not an object', async () => {
    expect(await refusal(db.sql, ['main'])).toBe(CHK);
    expect(await refusal(db.sql, [['main']])).toBe(CHK);
  });

  it('refuses an entry whose branch is missing, or is not a string', async () => {
    expect(await refusal(db.sql, [{ from: 'merge-branch' }])).toBe(CHK);
    expect(await refusal(db.sql, [{ branch: 7 }])).toBe(CHK);
    expect(await refusal(db.sql, [{ branch: null }])).toBe(CHK);
  });

  it('refuses an empty branch name, which names no branch at all', async () => {
    expect(await refusal(db.sql, [{ branch: '' }])).toBe(CHK);
  });

  // The two halves of one clause. A first entry has nothing above it to cross FROM, and an entry
  // below the first has an edge that must say how the release crosses it — the defaulting the old
  // `releaseModelGap` did, and which ADR 0003 removes.
  it('refuses a first entry that declares a crossing', async () => {
    expect(await refusal(db.sql, [{ branch: 'main', from: 'merge-branch' }])).toBe(CHK);
  });

  it('refuses a later entry that declares none', async () => {
    expect(await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main' }])).toBe(CHK);
  });

  // A json null is a PRESENT key whose value is not a crossing, and `NULL NOT IN (...)` is NULL
  // rather than true, so a predicate testing `-> 'from' IS NULL` took the row.
  it('refuses a later entry whose crossing is a json null, not an absent key', async () => {
    expect(await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: null }])).toBe(CHK);
  });

  it('refuses a FIRST entry that carries the key at all, json null included', async () => {
    expect(await refusal(db.sql, [{ branch: 'main', from: null }])).toBe(CHK);
  });

  it('refuses a crossing that is an object or an array rather than a name', async () => {
    expect(await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: {} }])).toBe(CHK);
    expect(
      await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: ['merge-branch'] }]),
    ).toBe(CHK);
  });

  it('refuses `tag-mr`, which 0312 removed rather than rewrote', async () => {
    expect(await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: 'tag-mr' }])).toBe(
      CHK,
    );
  });

  it('refuses a crossing that is not one of the two, rather than ignoring it', async () => {
    expect(await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: 'rebase' }])).toBe(
      CHK,
    );
    expect(await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: 12 }])).toBe(CHK);
  });

  // The column is jsonb, so an unexpected key is stored and read back for ever by anything that
  // walks the entry. Refusing it here is what stops `{branch, strategy}` becoming a second spelling
  // of the fact this issue just finished collapsing into one.
  it('refuses a key the entry does not declare', async () => {
    expect(await refusal(db.sql, [{ branch: 'main', strategy: 'merge-branch' }])).toBe(CHK);
    expect(
      await refusal(db.sql, [{ branch: 'dev' }, { branch: 'main', from: 'merge-branch', to: 'x' }]),
    ).toBe(CHK);
  });

  it('refuses a branch named twice, adjacent or not', async () => {
    expect(
      await refusal(db.sql, [{ branch: 'main' }, { branch: 'main', from: 'merge-branch' }]),
    ).toBe(CHK);
    expect(
      await refusal(db.sql, [
        { branch: 'dev' },
        { branch: 'stg', from: 'merge-branch' },
        { branch: 'dev', from: 'merge-branch' },
      ]),
    ).toBe(CHK);
  });
});

describe('the column itself', () => {
  it('defaults to an empty chain, so a row inserted naming nothing ships nothing', async () => {
    const late = await plantProjectPostMigration(db.sql, g, 'inserted-after-0312');
    const [row] = await db.sql.unsafe(`SELECT release_chain FROM projects WHERE id = $1`, [late]);
    expect((row as unknown as { release_chain: unknown }).release_chain).toEqual([]);
  });

  // Not the CHECK: the column is NOT NULL, so "this project has no release chain" is a state the
  // table cannot hold at all. `[]` says it ships nothing, and that is a declaration.
  it('refuses a SQL null, since "no chain" is not a shape this column has', async () => {
    let message = '';
    try {
      await db.sql.unsafe(`UPDATE projects SET release_chain = NULL WHERE id = $1`, [subject]);
    } catch (e) {
      message = (e as unknown as { message: string }).message;
    }
    expect(message).toMatch(/null value in column "release_chain"/i);
  });
});

/** A project inserted at the POST-0312 schema, naming no release chain at all. */
async function plantProjectPostMigration(sql: Sql, gr: Ground, slug: string): Promise<string> {
  const [row] = await sql.unsafe(
    `INSERT INTO projects (slug, name, created_by, org_id, base_branch)
     VALUES ($1, $2, $3, $4, 'main') RETURNING id`,
    [slug, slug, gr.ownerId, gr.orgId],
  );
  return (row as unknown as { id: string }).id;
}
