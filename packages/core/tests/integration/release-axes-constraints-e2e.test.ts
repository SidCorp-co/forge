/**
 * ISS-1046 — what the DATABASE refuses once `0253` has run, and what the way back does.
 *
 * Each CHECK is planted with the one value it exists to refuse and observed to refuse it, NAMING
 * its own constraint: the assertion is on the constraint name and not merely on rejection, because
 * a NOT NULL or a foreign key would also throw, and a test that only asserts "it threw" passes
 * after the rule it names has been dropped and something else refused the row. These rules live in
 * Postgres and not only in drizzle's `{ enum }`, which is a TypeScript annotation the database
 * never sees — raw SQL writes these two tables in several places and goes straight past a type.
 *
 * And the rollback. `db/migrate.js` never reads the `drizzle/rollback/` folder, so until this file
 * existed nothing in the repository had ever run `0253_down.sql` — the way back from a migration
 * that drops a column was a plan rather than a tested path. It is round-tripped over the whole
 * declared fleet here, because the forward map is not injective and an inverse computed from
 * `role` and `stages` is wrong on six known rows.
 *
 * What the forward run itself does is in `release-axes-migration-e2e.test.ts`; both stand on the
 * same ground module.
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
  runDown,
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

describe('0253 — the service rows `environment` was keeping apart', () => {
  // cm:why section 6b landed on `main` during the 36-minute outage this migration caused, in three
  // commits that changed only SQL and added no assertion. These are that assertion. The rule itself
  // is sound and it is the one piece of this migration that DERIVES rather than transcribes — on
  // purpose, because the two hand-written rosters each missed rows created after they were measured
  // and a rule reading the database at migration time cannot.

  /**
   * A `staging` service row beside a DECLARED `prod` one of the same project and provider —
   * separated by nothing but `environment`, which step 7 is about to drop.
   *
   * The sibling is declared rather than planted on purpose: the way back reads the declared list,
   * and a pair where BOTH rows are new is a pair the rollback refuses by name, which is its own
   * stated position rather than the behaviour these cases are about.
   */
  async function stagingRowBesideADeclaredDefault() {
    const { db, g, projects, bindings } = await fleet();
    const sibling = bindings.find((b) => b.role === 'service');
    if (!sibling) throw new Error('the declared table names no service binding');
    const host = projects.find((p) => p.slug === sibling.slug);
    if (!host) throw new Error(`no declared project for ${sibling.slug}`);
    const stagingId = await plantBinding(db.sql, g, {
      projectId: host.id,
      provider: sibling.provider,
      environment: 'staging',
      label: '',
    });
    return { db, g, host, prodId: sibling.id, stagingId };
  }

  // cm:guard the row is KEPT, not deleted, and the DEFAULT binding is the one that keeps `''` —
  // every lookup that asks for a project's postman binding without naming a label expects to find
  // the prod one where it has always been. Deleting either row to make the index build is the
  // failure this whole migration is written against.
  it('keeps both rows by moving the non-prod one to a label of its own', async () => {
    const { db, prodId, stagingId } = await stagingRowBesideADeclaredDefault();
    try {
      await runForward(db.sql);

      const rows = await db.sql.unsafe(
        `SELECT id, role, label FROM integration_bindings WHERE id IN ($1, $2) ORDER BY label`,
        [prodId, stagingId],
      );
      expect(rows.map((r) => [r.id, r.role, r.label])).toEqual([
        [prodId, 'service', ''],
        [stagingId, 'service', 'staging'],
      ]);
    } finally {
      await db.drop();
    }
  });

  // cm:guard a pair 6b cannot separate must ABORT BY NAME. Without the assertion that follows it,
  // `CREATE UNIQUE INDEX` refuses with a bare 23505 naming one key and no row — every other
  // refusal in this file names the rows a person has to decide about, and this one owes the same.
  it('aborts naming the pair when both already carry the same label', async () => {
    const { db, g, projects } = await fleet();
    try {
      const host = anyProject(projects);
      for (const environment of ['prod', 'staging']) {
        await plantBinding(db.sql, g, {
          projectId: host.id,
          provider: 'postman',
          environment,
          label: 'shared',
        });
      }

      await expect(runForward(db.sql)).rejects.toThrow(
        new RegExp(`${host.slug}/postman/'shared' x2`),
      );
    } finally {
      await db.drop();
    }
  });

  // cm:guard the way back undoes 6b, or the label becomes a permanent scar of a migration that was
  // rolled back: with `environment` restored the label states the same fact twice, and the pre-0253
  // unique index — (project, provider, environment, label) — would no longer find the default
  // binding where it left it.
  it('gives the label back on the way down, once environment carries the distinction again', async () => {
    const { db, prodId, stagingId } = await stagingRowBesideADeclaredDefault();
    try {
      await runForward(db.sql);
      await runDown(db.sql);

      const rows = await db.sql.unsafe(
        `SELECT id, environment, label FROM integration_bindings WHERE id IN ($1, $2) ORDER BY environment`,
        [prodId, stagingId],
      );
      expect(rows.map((r) => [r.id, r.environment, r.label])).toEqual([
        [prodId, 'prod', ''],
        [stagingId, 'staging', ''],
      ]);
    } finally {
      await db.drop();
    }
  });
});

describe('0253 backward — the way back is a file that has been run', () => {
  // cm:guard the forward map is NOT injective, which is the whole reason the down migration reads
  // the declared table instead of deriving an inverse. Three epodsystem 'prod' rows became
  // {preview,live} while three others became `service`, and getcontent's coolify 'staging' became
  // {live} — so a rule reading `preview ∈ stages → 'staging'` restores the first three wrongly and
  // `{live} → 'prod'` restores getcontent wrongly. A round trip over the WHOLE declared fleet is
  // what separates reading the declaration back from computing it.
  it('restores every binding to the exact environment it came in with', async () => {
    const { db, bindings } = await fleet();
    try {
      await runForward(db.sql);
      await runDown(db.sql);

      const rows = await db.sql.unsafe(`SELECT id, environment FROM integration_bindings`);
      const got = new Map(rows.map((r) => [r.id as string, r.environment as string]));
      expect(got.size).toBe(bindings.length);
      for (const b of bindings) {
        expect(got.get(b.id), `${b.slug}/${b.provider} (${b.role} ${b.stages.join('+')})`).toBe(
          b.oldEnvironment,
        );
      }
    } finally {
      await db.drop();
    }
  });

  it('puts the shape back: environment returns, role and stages go, live_branch is production_branch again', async () => {
    const { db } = await fleet();
    try {
      await runForward(db.sql);
      await runDown(db.sql);

      const bindingCols = (
        await db.sql.unsafe(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
        )
      ).map((c) => c.column_name as string);
      expect(bindingCols).toContain('environment');
      expect(bindingCols).not.toContain('role');
      expect(bindingCols).not.toContain('stages');

      const projectCols = (
        await db.sql.unsafe(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'`,
        )
      ).map((c) => c.column_name as string);
      expect(projectCols).toContain('production_branch');
      expect(projectCols).not.toContain('release_model');
      expect(projectCols).not.toContain('release_strategy');
    } finally {
      await db.drop();
    }
  });

  // cm:guard the rollback raises rather than guessing, in the same direction as the forward run.
  // A binding created AFTER the cutover has no declared environment to restore, and the file must
  // name it for a person rather than invent one — deleting the row or defaulting it is how a
  // rollback quietly loses a production binding somebody made.
  it('aborts naming a binding created after the cutover, rather than guessing its environment', async () => {
    const { db, g, projects } = await fleet();
    try {
      await runForward(db.sql);

      const strayId = randomUUID();
      const connectionId = randomUUID();
      await db.sql.unsafe(
        `INSERT INTO integration_connections (id, owner_type, owner_id, provider)
         VALUES ($1, 'user', $2, 'coolify')`,
        [connectionId, g.ownerId],
      );
      await db.sql.unsafe(
        `INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, label)
         VALUES ($1, $2, $3, 'coolify', 'deploy', ARRAY['live']::text[], 'made-after-the-cutover')`,
        [strayId, connectionId, anyProject(projects).id],
      );

      await expect(runDown(db.sql)).rejects.toThrow(new RegExp(strayId));
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

describe('0253 forward — the rules live in Postgres, and say no', () => {
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

  // `stages <@ ARRAY['preview','live']` is a CONTAINMENT test: it asks only that every element
  // belong to the vocabulary, so it passes a set that names one twice and a set with three
  // members. These three cases are the only thing standing between that spelling and this one.
  it('refuses a stage named twice, because `stages` is a set', async () => {
    const { db, g, projects } = await migrated();
    try {
      await expect(
        insertBinding(db.sql, g, anyProject(projects).id, 'deploy', ['live', 'live']),
      ).rejects.toThrow(/integration_bindings_role_stages_chk/);
      await expect(
        insertBinding(db.sql, g, anyProject(projects).id, 'deploy', ['preview', 'preview']),
      ).rejects.toThrow(/integration_bindings_role_stages_chk/);
    } finally {
      await db.drop();
    }
  });

  it('refuses a third member, although every member is in the vocabulary', async () => {
    const { db, g, projects } = await migrated();
    try {
      await expect(
        insertBinding(db.sql, g, anyProject(projects).id, 'deploy', ['preview', 'live', 'preview']),
      ).rejects.toThrow(/integration_bindings_role_stages_chk/);
    } finally {
      await db.drop();
    }
  });

  it('refuses a nested array, which containment alone admits', async () => {
    const { db, g, projects } = await migrated();
    try {
      const connectionId = randomUUID();
      await db.sql.unsafe(
        `INSERT INTO integration_connections (id, owner_type, owner_id, provider)
         VALUES ($1, 'user', $2, 'coolify')`,
        [connectionId, g.ownerId],
      );
      await expect(
        db.sql.unsafe(
          `INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, label)
           VALUES ($1, $2, $3, 'coolify', 'deploy', ARRAY[ARRAY['live']]::text[], $4)`,
          [
            randomUUID(),
            connectionId,
            anyProject(projects).id,
            `probe-${randomUUID().slice(0, 8)}`,
          ],
        ),
      ).rejects.toThrow(/integration_bindings_role_stages_chk/);
    } finally {
      await db.drop();
    }
  });
});

/**
 * The project half of the same declaration, in its own describe: the binding block above had
 * grown past the 150-line function budget, and a binding's shape and a project's release model
 * are two rules, not one.
 *
 * Every case asserts on the CONSTRAINT NAME rather than on the failure — a different constraint
 * refusing the same row would otherwise read as this one holding.
 */
describe('0253 forward — a project declares its release model, and Postgres holds it to it', () => {
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
