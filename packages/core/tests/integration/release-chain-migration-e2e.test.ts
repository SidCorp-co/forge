/**
 * ISS-1311 / ADR 0003 — what `0312` DOES to the rows that exist, and what it refuses to do.
 *
 * Three propositions, none of which a unit test can hold:
 *
 *   1. The mapping is ADR 0003's table, read off `release_model` and never off the branch names.
 *      25 of 32 fleet projects carry a `live_branch` nothing promotes to, so a chain derived from
 *      the branch pair moves them onto a two-step release nobody asked for — in silence.
 *
 *   2. A row the new schema cannot hold ABORTS and names the project. No stored row carries
 *      `tag-mr` (measured across 37 projects on 2026-09-27), so this refusal should never fire; it
 *      is planted and watched firing anyway, because a refusal nobody has seen is a comment.
 *
 *   3. The way back is a file that has been RUN. `db/migrate.ts` never reads `drizzle/rollback/`,
 *      so until this file existed nothing here had executed `0312_down.sql`.
 *
 * What the CHECK refuses once the migration has run is in `release-chain-constraints-e2e.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  axesOf,
  chainOf,
  type Ground,
  ground,
  type PreMigrationGround,
  plantProject,
  preMigrationGround,
  runDown,
  runForward,
  writeChain,
} from './release-chain-migration-ground.js';

let groundDb: PreMigrationGround;

beforeAll(async () => {
  groundDb = await preMigrationGround();
}, 300_000);

afterAll(async () => {
  await groundDb?.stop();
});

async function fleet(): Promise<{
  db: Awaited<ReturnType<PreMigrationGround['fresh']>>;
  g: Ground;
}> {
  const db = await groundDb.fresh();
  const g = await ground(db.sql);
  return { db, g };
}

describe('0312 forward — ADR 0003 table, read off the release model', () => {
  it('maps a `none` project to an empty chain, whatever branches it happens to carry', async () => {
    const { db, g } = await fleet();
    try {
      // The shape 25 of 32 fleet projects are in: a live branch left over from the era when the
      // column defaulted to `main`, and nothing that promotes to it.
      const stale = await plantProject(db.sql, g, {
        slug: 'none-with-a-stale-live-branch',
        model: 'none',
        base: 'release/stg',
        live: 'main',
      });

      await runForward(db.sql);

      expect(await chainOf(db.sql, stale.id)).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it('keeps the base branch of a `none` project, which is where its work is still cut from', async () => {
    const { db, g } = await fleet();
    try {
      const p = await plantProject(db.sql, g, {
        slug: 'none-keeps-its-work-branch',
        model: 'none',
        base: 'release/dev',
      });

      await runForward(db.sql);

      const [row] = await db.sql.unsafe(`SELECT base_branch FROM projects WHERE id = $1`, [p.id]);
      expect((row as unknown as { base_branch: string }).base_branch).toBe('release/dev');
    } finally {
      await db.drop();
    }
  });

  it('maps a `publish` project to the one branch it deploys', async () => {
    const { db, g } = await fleet();
    try {
      const p = await plantProject(db.sql, g, {
        slug: 'publishes-main',
        model: 'publish',
        base: 'main',
      });

      await runForward(db.sql);

      expect(await chainOf(db.sql, p.id)).toEqual([{ branch: 'main' }]);
    } finally {
      await db.drop();
    }
  });

  it('maps a `promote` project to base, then live by its own declared crossing', async () => {
    const { db, g } = await fleet();
    try {
      const p = await plantProject(db.sql, g, {
        slug: 'promotes-staging-to-master',
        model: 'promote',
        base: 'staging',
        live: 'master',
        strategy: 'merge-branch',
      });

      await runForward(db.sql);

      expect(await chainOf(db.sql, p.id)).toEqual([
        { branch: 'staging' },
        { branch: 'master', from: 'merge-branch' },
      ]);
    } finally {
      await db.drop();
    }
  });

  it('carries a cherry-pick crossing through as itself, never normalised to a merge', async () => {
    const { db, g } = await fleet();
    try {
      const p = await plantProject(db.sql, g, {
        slug: 'promotes-by-cherry-pick',
        model: 'promote',
        base: 'dev',
        live: 'live',
        strategy: 'cherry-pick',
      });

      await runForward(db.sql);

      expect(await chainOf(db.sql, p.id)).toEqual([
        { branch: 'dev' },
        { branch: 'live', from: 'cherry-pick' },
      ]);
    } finally {
      await db.drop();
    }
  });

  it('takes a project created after the measurement with no declaration at all', async () => {
    const { db, g } = await fleet();
    try {
      // `release_model` is NOT NULL DEFAULT 'none', so a row inserted between the measurement and
      // the deploy arrives declaring nothing. That is an answer here and not a gap: the column's
      // own default and the chain's own default say the same thing.
      const late = await plantProject(db.sql, g, { slug: 'made-while-it-waited', model: 'none' });

      await runForward(db.sql);

      expect(await chainOf(db.sql, late.id)).toEqual([]);
    } finally {
      await db.drop();
    }
  });
});

describe('0312 forward — the rows this schema cannot hold, refused by name', () => {
  it('aborts naming a project that carries `tag-mr`, rather than rewriting it to merge-branch', async () => {
    const { db, g } = await fleet();
    try {
      const doomed = await plantProject(db.sql, g, {
        slug: 'declares-tag-mr',
        model: 'promote',
        base: 'main',
        live: 'release',
        strategy: 'tag-mr',
      });

      await expect(runForward(db.sql)).rejects.toThrow(
        new RegExp(`${doomed.id}[\\s\\S]*declares-tag-mr`),
      );
      await expect(runForward(db.sql)).rejects.toThrow(/tag-mr/);
    } finally {
      await db.drop();
    }
  });

  it('leaves every other project untouched when it aborts, since it is one transaction', async () => {
    const { db, g } = await fleet();
    try {
      const fine = await plantProject(db.sql, g, {
        slug: 'would-have-been-fine',
        model: 'publish',
        base: 'main',
      });
      await plantProject(db.sql, g, {
        slug: 'the-one-that-aborts',
        model: 'promote',
        base: 'main',
        live: 'release',
        strategy: 'tag-mr',
      });

      await expect(runForward(db.sql)).rejects.toThrow(/tag-mr/);

      const [row] = await db.sql.unsafe(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'release_chain'`,
      );
      expect((row as unknown as { n: number }).n).toBe(0);
      expect((await axesOf(db.sql, fine.id)).release_model).toBe('publish');
    } finally {
      await db.drop();
    }
  });

  it('aborts naming a project that declares a release and no base branch to start it from', async () => {
    const { db, g } = await fleet();
    try {
      const doomed = await plantProject(db.sql, g, {
        slug: 'ships-from-nowhere',
        model: 'publish',
        base: null,
      });

      await expect(runForward(db.sql)).rejects.toThrow(
        new RegExp(`${doomed.id}[\\s\\S]*ships-from-nowhere`),
      );
      await expect(runForward(db.sql)).rejects.toThrow(/Do NOT default it/);
    } finally {
      await db.drop();
    }
  });

  it('does NOT abort on a `none` project with no base branch, which declares no release to start', async () => {
    const { db, g } = await fleet();
    try {
      const p = await plantProject(db.sql, g, {
        slug: 'ships-nothing-from-nowhere',
        model: 'none',
        base: null,
      });

      await runForward(db.sql);

      expect(await chainOf(db.sql, p.id)).toEqual([]);
    } finally {
      await db.drop();
    }
  });
});

describe('0312 backward — the way back is a file that has been run', () => {
  it('restores each project to the exact four columns it came in with', async () => {
    const { db, g } = await fleet();
    try {
      const declared = [
        { slug: 'back-none', model: 'none' as const, base: 'dev', live: null, strategy: null },
        {
          slug: 'back-publish',
          model: 'publish' as const,
          base: 'main',
          live: null,
          strategy: null,
        },
        {
          slug: 'back-promote',
          model: 'promote' as const,
          base: 'staging',
          live: 'master',
          strategy: 'merge-branch',
        },
        {
          slug: 'back-cherry',
          model: 'promote' as const,
          base: 'dev',
          live: 'live',
          strategy: 'cherry-pick',
        },
      ];
      const planted = [];
      for (const row of declared) planted.push(await plantProject(db.sql, g, row));

      await runForward(db.sql);
      await runDown(db.sql);

      for (const [i, p] of planted.entries()) {
        const row = declared[i];
        expect({ slug: p.slug, ...(await axesOf(db.sql, p.id)) }).toEqual({
          slug: p.slug,
          base_branch: row?.base ?? null,
          live_branch: row?.live ?? null,
          release_model: row?.model,
          release_strategy: row?.strategy ?? null,
        });
      }
    } finally {
      await db.drop();
    }
  });

  it('puts the shape back: the three columns and their CHECKs return, the chain goes', async () => {
    const { db, g } = await fleet();
    try {
      await plantProject(db.sql, g, { slug: 'shape', model: 'publish', base: 'main' });

      await runForward(db.sql);
      await runDown(db.sql);

      const cols = await db.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'`,
      );
      const names = cols.map((c) => (c as unknown as { column_name: string }).column_name);
      expect(names).toEqual(
        expect.arrayContaining(['release_model', 'live_branch', 'release_strategy']),
      );
      expect(names).not.toContain('release_chain');

      const checks = await db.sql.unsafe(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'projects'::regclass AND contype = 'c'`,
      );
      const conNames = checks.map((c) => (c as unknown as { conname: string }).conname);
      expect(conNames).toEqual(
        expect.arrayContaining([
          'projects_release_model_chk',
          'projects_live_branch_chk',
          'projects_release_strategy_chk',
        ]),
      );
      expect(conNames).not.toContain('projects_release_chain_chk');
    } finally {
      await db.drop();
    }
  });

  // The loss ADR 0003 names and accepts. It is asserted rather than described, so nobody reaches
  // for this file believing it restores a value it cannot.
  it('does NOT restore the orphan live branch of a project whose chain was shorter than two', async () => {
    const { db, g } = await fleet();
    try {
      const orphan = await plantProject(db.sql, g, {
        slug: 'orphan-live-branch',
        model: 'none',
        base: 'release/stg',
        live: 'main',
      });

      await runForward(db.sql);
      await runDown(db.sql);

      const axes = await axesOf(db.sql, orphan.id);
      expect(axes.release_model).toBe('none');
      expect(axes.base_branch).toBe('release/stg');
      expect(axes.live_branch).toBeNull();
    } finally {
      await db.drop();
    }
  });

  it('aborts naming a project whose chain is longer than the three columns can hold', async () => {
    const { db, g } = await fleet();
    try {
      const long = await plantProject(db.sql, g, {
        slug: 'three-environments',
        model: 'promote',
        base: 'dev',
        live: 'main',
        strategy: 'merge-branch',
      });

      await runForward(db.sql);
      await writeChain(db.sql, long.id, [
        { branch: 'dev' },
        { branch: 'stg', from: 'merge-branch' },
        { branch: 'main', from: 'merge-branch' },
      ]);

      await expect(runDown(db.sql)).rejects.toThrow(
        new RegExp(`${long.id}[\\s\\S]*three-environments`),
      );
      await expect(runDown(db.sql)).rejects.toThrow(/Shorten each chain/);
    } finally {
      await db.drop();
    }
  });
});
