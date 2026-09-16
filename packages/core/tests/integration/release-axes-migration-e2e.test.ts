/**
 * ISS-1046 — `0253_declared_release_axes.sql` walked against a real Postgres.
 *
 * Three things are proved here and nowhere else. That the migration REFUSES a
 * project or a binding its declared table does not name, rather than defaulting
 * it — the whole change exists to stop a value being guessed, and a backfill
 * that quietly guesses one would reintroduce the defect in the act of removing
 * it. That the declaration actually reaches every row, which a join on the wrong
 * column would not. And that each CHECK is planted with the value it exists to
 * refuse and observed to refuse it, naming its own constraint: these live in
 * Postgres and not in drizzle's `{ enum }`, because raw SQL writes these two
 * tables in several places and goes straight past a TypeScript annotation.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  declaredBindings,
  declaredProjects,
  type Ground,
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
      const keep = ['adminhub-api', 'epodsystem-core', 'sidboss'];
      const branches = new Map([
        ['adminhub-api', 'release/production'],
        ['epodsystem-core', 'master'],
        ['sidboss', 'main'],
      ]);
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

/**
 * Each constraint met with the one value it exists to refuse. The assertion is on
 * the constraint NAME in the error, not merely on rejection: a NOT NULL or a
 * foreign key would also throw, and a test that only asserts "it threw" passes
 * when the rule it names has been dropped and something else refused the row.
 */
describe('0253 forward — the rules live in Postgres, and say no', () => {
  async function migrated() {
    const f = await fleet();
    await runForward(f.db.sql);
    return f;
  }

  async function insertBinding(
    sql: Awaited<ReturnType<typeof fleet>>['db']['sql'],
    g: Ground,
    projectId: string,
    role: string,
    stages: string[],
    label = `probe-${randomUUID().slice(0, 8)}`,
  ) {
    const connectionId = randomUUID();
    await sql.unsafe(
      `INSERT INTO integration_connections (id, owner_type, owner_id, provider)
       VALUES ($1, 'user', $2, 'coolify')`,
      [connectionId, g.ownerId],
    );
    return sql.unsafe(
      `INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, label)
       VALUES ($1, $2, $3, 'coolify', $4, $5::text[], $6)`,
      [randomUUID(), connectionId, projectId, role, stages, label],
    );
  }

  it('refuses a binding role that is neither deploy nor service', async () => {
    const { db, g, projects } = await migrated();
    try {
      await expect(
        insertBinding(db.sql, g, anyProject(projects).id, 'publisher', []),
      ).rejects.toThrow(/integration_bindings_role_chk/);
    } finally {
      await db.drop();
    }
  });

  it('refuses a service binding that carries any stage', async () => {
    const { db, g, projects } = await migrated();
    try {
      await expect(
        insertBinding(db.sql, g, anyProject(projects).id, 'service', ['live']),
      ).rejects.toThrow(/integration_bindings_role_stages_chk/);
    } finally {
      await db.drop();
    }
  });

  // cm:guard THE counterexample for `cardinality` over `array_length`:
  // `array_length('{}', 1)` is NULL, so the same rule written that way evaluates to
  // NULL on the empty array and PASSES this row. This case is the only thing that
  // separates the two spellings, and it goes green under the wrong one.
  it('refuses a deploy binding whose stage array is empty', async () => {
    const { db, g, projects } = await migrated();
    try {
      await expect(insertBinding(db.sql, g, anyProject(projects).id, 'deploy', [])).rejects.toThrow(
        /integration_bindings_role_stages_chk/,
      );
    } finally {
      await db.drop();
    }
  });

  it('refuses a stage value that is neither preview nor live', async () => {
    const { db, g, projects } = await migrated();
    try {
      await expect(
        insertBinding(db.sql, g, anyProject(projects).id, 'deploy', ['staging']),
      ).rejects.toThrow(/integration_bindings_role_stages_chk/);
      await expect(
        insertBinding(db.sql, g, anyProject(projects).id, 'deploy', ['live', 'prod']),
      ).rejects.toThrow(/integration_bindings_role_stages_chk/);
    } finally {
      await db.drop();
    }
  });

  it('refuses a release model that is none of none, promote and publish', async () => {
    const { db, projects } = await migrated();
    try {
      await expect(
        db.sql.unsafe(`UPDATE projects SET release_model = 'weekly' WHERE id = $1`, [
          anyProject(projects).id,
        ]),
      ).rejects.toThrow(/projects_release_model_chk/);
    } finally {
      await db.drop();
    }
  });

  it('refuses a promote project whose live branch is null', async () => {
    const { db } = await migrated();
    try {
      const promoter = declaredProjects().find((p) => p.releaseModel === 'promote');
      if (!promoter) throw new Error('no declared promote project');
      await expect(
        db.sql.unsafe(`UPDATE projects SET live_branch = NULL WHERE id = $1`, [promoter.id]),
      ).rejects.toThrow(/projects_live_branch_chk/);
    } finally {
      await db.drop();
    }
  });

  it('refuses a release strategy set while the release model is not promote', async () => {
    const { db } = await migrated();
    try {
      const quiet = declaredProjects().find((p) => p.releaseModel === 'none');
      if (!quiet) throw new Error('no declared none project');
      await expect(
        db.sql.unsafe(`UPDATE projects SET release_strategy = 'merge-branch' WHERE id = $1`, [
          quiet.id,
        ]),
      ).rejects.toThrow(/projects_release_strategy_chk/);
    } finally {
      await db.drop();
    }
  });

  it('refuses a release strategy that is null while the release model is promote', async () => {
    const { db } = await migrated();
    try {
      const promoter = declaredProjects().find((p) => p.releaseModel === 'promote');
      if (!promoter) throw new Error('no declared promote project');
      await expect(
        db.sql.unsafe(`UPDATE projects SET release_strategy = NULL WHERE id = $1`, [promoter.id]),
      ).rejects.toThrow(/projects_release_strategy_chk/);
    } finally {
      await db.drop();
    }
  });

  it('refuses a release strategy that is not one of the three spellings', async () => {
    const { db } = await migrated();
    try {
      const promoter = declaredProjects().find((p) => p.releaseModel === 'promote');
      if (!promoter) throw new Error('no declared promote project');
      await expect(
        db.sql.unsafe(`UPDATE projects SET release_strategy = 'rebase' WHERE id = $1`, [
          promoter.id,
        ]),
      ).rejects.toThrow(/projects_release_strategy_chk/);
    } finally {
      await db.drop();
    }
  });

  // cm:guard uniqueness survives for `service` rows ONLY. Both halves are asserted:
  // dropping the index passes the first, and widening it to every row passes the
  // second, so neither alone holds the rule the change actually made.
  it('holds one active service binding per project, provider and label — and no ceiling on deploy', async () => {
    const { db, g, projects } = await migrated();
    try {
      const connectionId = randomUUID();
      await db.sql.unsafe(
        `INSERT INTO integration_connections (id, owner_type, owner_id, provider)
         VALUES ($1, 'user', $2, 'postman')`,
        [connectionId, g.ownerId],
      );
      const service = (label: string) =>
        db.sql.unsafe(
          `INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, label)
           VALUES ($1, $2, $3, 'postman', 'service', '{}'::text[], $4)`,
          [randomUUID(), connectionId, anyProject(projects).id, label],
        );
      await service('one');
      await expect(service('one')).rejects.toThrow(/integration_bindings_service_uq/);

      // the SAME (project, provider, label) on a deploy binding is allowed, twice
      // over — the tuple that just collided is the tuple that must not collide here
      await insertBinding(db.sql, g, anyProject(projects).id, 'deploy', ['live'], 'one');
      await insertBinding(db.sql, g, anyProject(projects).id, 'deploy', ['live'], 'one');
    } finally {
      await db.drop();
    }
  });
});
