/**
 * ISS-1046 — the ground `0253_declared_release_axes.sql` stands on: a database at
 * the schema it expects to FIND, which the harness's own database no longer has
 * because it is already migrated past it.
 *
 * Every migration below 0253 goes into one template once per file; each case
 * clones it. That is the only way to plant the binding the migration must refuse
 * — after the forward run there is no `environment` column left to plant into.
 *
 * Modelled on `conversations-migration-ground.ts`, which does the same for 0241.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));

/** The statement list of 0253, and everything below it. */
function migrationParts(): { below: string[]; releaseAxes: string[] } {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  const target = files.find((f) => f.sql.join('\n').includes('iss1046_bindings'));
  if (!target) throw new Error('0253_declared_release_axes.sql is not in the migrations folder');
  const below = files
    .filter((f) => f.folderMillis < target.folderMillis)
    .sort((a, b) => a.folderMillis - b.folderMillis)
    .flatMap((f) => f.sql);
  return { below, releaseAxes: target.sql };
}

export const { below, releaseAxes } = migrationParts();

/**
 * The declaration the migration carries, parsed back out of its own VALUES lists.
 *
 * Not a tautology: what these drive is the assertion that the `UPDATE … FROM`
 * join actually reaches every planted row. A join that misses — a row whose id
 * never matches, an ON clause on the wrong column — leaves the declared value
 * unapplied, and only a comparison against the declaration can see it.
 */
export interface DeclaredProject {
  id: string;
  slug: string;
  releaseModel: string;
  releaseStrategy: string | null;
}
export interface DeclaredBinding {
  id: string;
  slug: string;
  provider: string;
  oldEnvironment: string;
  role: string;
  stages: string[];
}

/** A capture group the pattern guarantees; a miss is a parser bug, not a data case. */
function group(m: RegExpMatchArray, i: number): string {
  const v = m[i];
  if (v === undefined) throw new Error(`0253 VALUES parse: group ${i} missing in ${m[0]}`);
  return v;
}

function valuesBlock(marker: string): string {
  const sql = releaseAxes.join('\n');
  const at = sql.indexOf(marker);
  if (at < 0) throw new Error(`no VALUES list for ${marker}`);
  const end = sql.indexOf(';', at);
  return sql.slice(at, end);
}

export function declaredProjects(): DeclaredProject[] {
  const block = valuesBlock('INSERT INTO iss1046_projects');
  const rows = [
    ...block.matchAll(/\('([0-9a-f-]{36})',\s*'([^']+)',\s*'([^']+)',\s*(NULL|'[^']+')\)/g),
  ];
  if (rows.length === 0) throw new Error('parsed no declared projects');
  return rows.map((m) => ({
    id: group(m, 1),
    slug: group(m, 2),
    releaseModel: group(m, 3),
    releaseStrategy: group(m, 4) === 'NULL' ? null : group(m, 4).slice(1, -1),
  }));
}

export function declaredBindings(): DeclaredBinding[] {
  const block = valuesBlock('INSERT INTO iss1046_bindings');
  const rows = [
    ...block.matchAll(
      /\('([0-9a-f-]{36})',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(ARRAY\[[^\]]*\]::text\[\]|'\{\}'::text\[\])\)/g,
    ),
  ];
  if (rows.length === 0) throw new Error('parsed no declared bindings');
  return rows.map((m) => ({
    id: group(m, 1),
    slug: group(m, 2),
    provider: group(m, 3),
    oldEnvironment: group(m, 4),
    role: group(m, 5),
    stages: [...group(m, 6).matchAll(/'([a-z]+)'/g)].map((s) => group(s, 1)),
  }));
}

export interface PreMigrationGround {
  fresh(): Promise<{ sql: Sql; drop: () => Promise<void> }>;
  stop(): Promise<void>;
}

/** Build the template, and hand back a cloner for it. */
export async function preMigrationGround(): Promise<PreMigrationGround> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const template = `iss1046_tpl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.unsafe(`CREATE DATABASE "${template}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${template}`;
  const tpl = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await tpl.begin(async (tx) => {
      for (const stmt of below) await tx.unsafe(stmt, []);
    });
  } finally {
    await tpl.end({ timeout: 5 });
  }

  return {
    async fresh() {
      const name = `iss1046_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
      const dbUrl = new URL(adminUrl);
      dbUrl.pathname = `/${name}`;
      const sql = postgres(dbUrl.toString(), { max: 1, onnotice: () => {} });
      return {
        sql,
        drop: async () => {
          await sql.end({ timeout: 5 }).catch(() => {});
          await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
        },
      };
    },
    async stop() {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`).catch(() => {});
      await admin.end({ timeout: 5 });
    },
  };
}

/** Run the forward migration as drizzle runs it: every statement, one transaction. */
export async function runForward(sql: Sql, statements: string[] = releaseAxes): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of statements) await tx.unsafe(stmt, []);
  });
}

/**
 * The rollback, `drizzle/rollback/0253_down.sql`, run the way an operator runs it.
 *
 * Nothing else in this repository executes this file: `db/migrate.js` never reads the rollback
 * folder, so until it is run here it is a plan rather than a way back — and it is the ONLY way back
 * from a migration that drops a column, which is exactly the file nobody discovers is broken until
 * the hour they need it.
 *
 * It opens its own `BEGIN`/`COMMIT`, matching the `psql -f` the file's own header prescribes, so
 * it is sent whole rather than split at drizzle's statement breakpoints.
 */
export async function runDown(sql: Sql): Promise<void> {
  const path = fileURLToPath(new URL('../../drizzle/rollback/0253_down.sql', import.meta.url));
  await sql.unsafe(readFileSync(path, 'utf8'));
}

export interface Ground {
  orgId: string;
  ownerId: string;
}

/** An org and a person — the ground a project sits on. */
export async function ground(sql: Sql): Promise<Ground> {
  const ownerId = randomUUID();
  const orgId = randomUUID();
  await sql.unsafe(
    `INSERT INTO users (id, email, kind, email_verified_at) VALUES ($1, $2, 'human', now())`,
    [ownerId, `owner-${ownerId.slice(0, 8)}@example.com`],
  );
  await sql.unsafe(
    `INSERT INTO organizations (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`,
    [orgId, `org ${orgId.slice(0, 8)}`, `org-${orgId.slice(0, 8)}`, ownerId],
  );
  return { orgId, ownerId };
}

export async function plantProject(
  sql: Sql,
  g: Ground,
  row: {
    id?: string;
    slug: string;
    productionBranch?: string | null;
    archived?: boolean;
    createdAt?: Date;
  },
): Promise<string> {
  const id = row.id ?? randomUUID();
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, created_by, org_id, production_branch, archived_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))`,
    [
      id,
      row.slug,
      row.slug,
      g.ownerId,
      g.orgId,
      row.productionBranch ?? null,
      row.archived ? new Date() : null,
      row.createdAt ?? null,
    ],
  );
  return id;
}

export async function plantBinding(
  sql: Sql,
  g: Ground,
  row: {
    id?: string;
    projectId: string;
    provider: string;
    environment: string;
    label?: string;
    active?: boolean;
  },
): Promise<string> {
  const id = row.id ?? randomUUID();
  const connectionId = randomUUID();
  await sql.unsafe(
    `INSERT INTO integration_connections (id, owner_type, owner_id, provider)
     VALUES ($1, 'user', $2, $3)`,
    [connectionId, g.ownerId, row.provider],
  );
  await sql.unsafe(
    `INSERT INTO integration_bindings (id, connection_id, project_id, provider, environment, label, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      connectionId,
      row.projectId,
      row.provider,
      row.environment,
      row.label ?? '',
      row.active ?? true,
    ],
  );
  return id;
}

/**
 * Older than 0253's deploy-window floor (`2026-09-16 17:26:00+00`).
 *
 * A project planted at `now()` is INSIDE that window, where the migration forces `none` rather
 * than aborting. A case meaning to prove the ABORT plants an older row on purpose, or it proves
 * the exemption instead and reads as a passing test of nothing.
 */
export const BEFORE_THE_WINDOW = new Date('2026-09-01T00:00:00Z');

/** The first declared project, as a value rather than an index read. */
export function anyProject(projects: { id: string; slug: string }[]): { id: string; slug: string } {
  const first = projects[0];
  if (!first) throw new Error('the declared table names no projects');
  return first;
}

/**
 * A fresh database with the whole declared fleet planted at its pre-0253 shape.
 *
 * Shared rather than copied, because two test files now stand on it and a second copy would let
 * them disagree about what "the fleet" is — which is how one of them goes green against a fleet
 * the migration never sees.
 */
export async function declaredFleet(gd: PreMigrationGround): Promise<{
  db: { sql: Sql; drop: () => Promise<void> };
  g: Ground;
  projects: DeclaredProject[];
  bindings: DeclaredBinding[];
}> {
  const db = await gd.fresh();
  const g = await ground(db.sql);
  const projects = declaredProjects();
  const bindings = declaredBindings();
  const bySlug = new Map<string, string>();
  for (const p of projects) {
    // `promote` needs a branch to satisfy projects_live_branch_chk; the six real
    // ones are asserted by name in the rename case.
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
