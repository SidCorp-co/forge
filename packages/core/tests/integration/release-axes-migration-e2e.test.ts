/**
 * ISS-1046 — what `0253_declared_release_axes.sql` DOES, walked against a real Postgres.
 *
 * Two things are proved here. That the migration REFUSES a project or a binding its declared table
 * does not name, rather than defaulting it — the whole change exists to stop a value being guessed,
 * and a backfill that quietly guesses one would reintroduce the defect in the act of removing it.
 * And that the declaration actually reaches every row, which a join on the wrong column would not.
 *
 * What the DATABASE refuses afterwards, and what the way back does, are in
 * `release-axes-constraints-e2e.test.ts`: those are assertions about constraints and about a
 * separate SQL file rather than about the forward run, and both files stand on the same ground.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  declaredBindings,
  declaredProjects,
  ground,
  type PreMigrationGround,
  plantBinding,
  plantProject,
  preMigrationGround,
  runForward,
} from './release-axes-migration-ground.js';

let groundDb: PreMigrationGround;

beforeAll(async () => {
  groundDb = await preMigrationGround();
}, 300_000);

afterAll(async () => {
  if (groundDb) await groundDb.stop();
});

const freshDb = () => groundDb.fresh();

/** The first declared project, as a value rather than an index read. */
function anyProject(projects: { id: string; slug: string }[]): { id: string; slug: string } {
  const first = projects[0];
  if (!first) throw new Error('the declared table names no projects');
  return first;
}

/** The single row a count query returns. */
function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${what}: query returned no row`);
  return row;
}

/** A database with the whole declared fleet planted at its pre-0253 shape. */
async function fleet() {
  const db = await freshDb();
  const g = await ground(db.sql);
  const projects = declaredProjects();
  const bindings = declaredBindings();
  const bySlug = new Map<string, string>();
  for (const p of projects) {
    // `promote` needs a branch to satisfy projects_live_branch_chk; the six real
    // ones are asserted by name in the rename case below.
    await plantProject(db.sql, g, {
      id: p.id,
      slug: p.slug,
      productionBranch: p.releaseModel === 'promote' ? 'production' : null,
    });
    bySlug.set(p.slug, p.id);
  }
  for (const b of bindings) {
    const projectId = bySlug.get(b.slug);
    if (!projectId) throw new Error(`declared binding ${b.id} names unknown project ${b.slug}`);
    await plantBinding(db.sql, g, {
      id: b.id,
      projectId,
      provider: b.provider,
      environment: b.oldEnvironment,
      label: '',
    });
  }
  return { db, g, projects, bindings };
}

describe('0253 forward — a row it cannot map stops the deploy', () => {
  // cm:guard the refusal is the deliverable. A binding created after the fleet was
  // measured carries an `environment` that meant one of three different things, and
  // only its owner knows which — so the migration names it and applies nothing,
  // rather than defaulting it to the reading that happens to be commonest.
  it('aborts naming the binding its declared table does not cover, and applies nothing', async () => {
    const { db, g, projects } = await fleet();
    try {
      const strayId = randomUUID();
      await plantBinding(db.sql, g, {
        id: strayId,
        projectId: anyProject(projects).id,
        provider: 'coolify',
        environment: 'prod',
        label: 'made-after-the-snapshot',
      });

      await expect(runForward(db.sql)).rejects.toThrow(new RegExp(strayId));

      // applied nothing: the old column is still there and the new ones are not
      const cols = await db.sql.unsafe(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'integration_bindings'`,
      );
      const names = cols.map((c) => c.column_name as string);
      expect(names).toContain('environment');
      expect(names).not.toContain('role');
    } finally {
      await db.drop();
    }
  });

  // cm:guard the binding table cannot see a project that has no bindings — 20 of the
  // 32 are invisible to it — so release_model gets a coverage assertion of its own.
  // Without it an unlisted project reaches SET NOT NULL and fails with Postgres's
  // generic message instead of naming the project a person has to decide about.
  it('aborts naming a project its declared table does not cover, even with no bindings', async () => {
    const { db, g } = await fleet();
    try {
      const strayId = randomUUID();
      await plantProject(db.sql, g, { id: strayId, slug: 'made-after-the-snapshot' });

      await expect(runForward(db.sql)).rejects.toThrow(
        new RegExp(`${strayId}.*made-after-the-snapshot`, 's'),
      );
    } finally {
      await db.drop();
    }
  });

  it('aborts on an INACTIVE binding it does not cover, not only an active one', async () => {
    const { db, g, projects } = await fleet();
    try {
      const strayId = randomUUID();
      await plantBinding(db.sql, g, {
        id: strayId,
        projectId: anyProject(projects).id,
        provider: 'sentry',
        environment: 'prod',
        label: 'retired-but-still-a-row',
        active: false,
      });

      await expect(runForward(db.sql)).rejects.toThrow(new RegExp(strayId));
    } finally {
      await db.drop();
    }
  });

  it('aborts naming a project declared `promote` that has no branch to promote to', async () => {
    const { db } = await fleet();
    try {
      const promoter = declaredProjects().find((p) => p.releaseModel === 'promote');
      if (!promoter) throw new Error('no declared promote project to test with');
      await db.sql.unsafe(`UPDATE projects SET production_branch = NULL WHERE id = $1`, [
        promoter.id,
      ]);

      await expect(runForward(db.sql)).rejects.toThrow(new RegExp(promoter.slug));
    } finally {
      await db.drop();
    }
  });
});

describe('0253 forward — the declaration reaches every row', () => {
  it('gives each declared binding the role and stages its declaration names', async () => {
    const { db, bindings } = await fleet();
    try {
      await runForward(db.sql);

      const rows = await db.sql.unsafe(`SELECT id, role, stages FROM integration_bindings`);
      const got = new Map(rows.map((r) => [r.id as string, r]));
      expect(got.size).toBe(bindings.length);
      for (const b of bindings) {
        const row = got.get(b.id);
        expect(row, `binding ${b.id} (${b.slug}/${b.provider}) survived`).toBeDefined();
        expect(row?.role, `role of ${b.slug}/${b.provider}`).toBe(b.role);
        expect(
          [...((row?.stages ?? []) as string[])].sort(),
          `stages of ${b.slug}/${b.provider}`,
        ).toEqual([...b.stages].sort());
      }
    } finally {
      await db.drop();
    }
  });

  it('gives each declared project the release model and strategy its declaration names', async () => {
    const { db, projects } = await fleet();
    try {
      await runForward(db.sql);

      const rows = await db.sql.unsafe(
        `SELECT id, slug, release_model, release_strategy FROM projects`,
      );
      const got = new Map(rows.map((r) => [r.id as string, r]));
      expect(got.size).toBe(projects.length);
      for (const p of projects) {
        const row = got.get(p.id);
        expect(row?.release_model, `release_model of ${p.slug}`).toBe(p.releaseModel);
        expect(row?.release_strategy, `release_strategy of ${p.slug}`).toBe(p.releaseStrategy);
      }
    } finally {
      await db.drop();
    }
  });

  // cm:guard 34 rows in, 34 rows out. The issue's own Outcome sentence said the three
  // duplicate coolify pairs merge to one `live` binding each; the correction of
  // 2026-09-16 resolved that against its Rules, which forbid dropping a row to tidy
  // the model. A migration that deleted one of each pair would still pass every
  // assertion above, because it would delete rows the declaration also covers.
  it('drops no binding row, leaving each duplicate coolify pair as preview beside live', async () => {
    const { db, bindings } = await fleet();
    try {
      const before = one(
        await db.sql.unsafe(`SELECT count(*)::int AS n FROM integration_bindings`),
        'binding count before',
      );
      await runForward(db.sql);
      const after = one(
        await db.sql.unsafe(`SELECT count(*)::int AS n FROM integration_bindings`),
        'binding count after',
      );
      expect(after.n).toBe(before.n);
      expect(after.n).toBe(bindings.length);

      // the three named pairs, each still two rows: one preview, one live
      for (const slug of ['brand-gateway', 'ceo-dashboard', 'finance-automation']) {
        const pair = await db.sql.unsafe(
          `SELECT b.stages FROM integration_bindings b
             JOIN projects p ON p.id = b.project_id
            WHERE p.slug = $1 AND b.provider = 'coolify'`,
          [slug],
        );
        expect(pair, `${slug} keeps both coolify rows`).toHaveLength(2);
        expect(pair.map((r) => (r.stages as string[]).join(',')).sort()).toEqual([
          'live',
          'preview',
        ]);
      }
    } finally {
      await db.drop();
    }
  });

  it('renames production_branch to live_branch with every stored value preserved', async () => {
    const { db, g } = await fleet();
    try {
      // the six fleet projects that carry a real branch under a non-promote model
      const declared = declaredProjects();
      // All SIX the decision record names, not a sample: a regression that cleared one of the
      // three left out would have passed while the case claimed to cover them.
      const branches = new Map([
        ['adminhub-api', 'release/production'],
        ['adminhub-ui', 'release/production'],
        ['epodsystem-core', 'master'],
        ['sidcorp-mail', 'master'],
        ['house-supabase', 'main'],
        ['sidboss', 'main'],
      ]);
      const keep = [...branches.keys()];
      for (const slug of keep) {
        const p = declared.find((d) => d.slug === slug);
        if (!p) throw new Error(`${slug} is not in the declared table`);
        expect(p.releaseModel).not.toBe('promote');
        const branch = branches.get(slug);
        if (!branch) throw new Error(`no branch fixture for ${slug}`);
        await db.sql.unsafe(`UPDATE projects SET production_branch = $1 WHERE id = $2`, [
          branch,
          p.id,
        ]);
      }

      await runForward(db.sql);

      const cols = await db.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'`,
      );
      const names = cols.map((c) => c.column_name as string);
      expect(names).toContain('live_branch');
      expect(names).not.toContain('production_branch');

      for (const slug of keep) {
        const [row] = await db.sql.unsafe(`SELECT live_branch FROM projects WHERE slug = $1`, [
          slug,
        ]);
        expect(row?.live_branch, `${slug} keeps the branch it declared`).toBe(branches.get(slug));
      }
      expect(g).toBeDefined();
    } finally {
      await db.drop();
    }
  });

  it('leaves integration_bindings with no environment column and a NOT NULL role', async () => {
    const { db } = await fleet();
    try {
      await runForward(db.sql);

      const [role] = await db.sql.unsafe(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'integration_bindings' AND column_name = 'role'`,
      );
      expect(role?.is_nullable).toBe('NO');
      const env = await db.sql.unsafe(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'integration_bindings' AND column_name = 'environment'`,
      );
      expect(env).toHaveLength(0);

      const [model] = await db.sql.unsafe(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'release_model'`,
      );
      expect(model?.is_nullable).toBe('NO');
    } finally {
      await db.drop();
    }
  });
});
