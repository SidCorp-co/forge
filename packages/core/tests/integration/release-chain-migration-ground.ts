/**
 * ISS-1311 — the ground `0312_a_release_chain_replaces_the_release_model.sql` stands on: a database
 * at the schema it expects to FIND, which the harness's own database no longer has because it is
 * already migrated past it.
 *
 * Every migration below 0312 goes into one template once per file; each case clones it. That is the
 * only way to plant the `tag-mr` row the migration must refuse — after the forward run there is no
 * `release_strategy` column left to plant into.
 *
 * Modelled on `release-axes-migration-ground.ts`, which does the same for 0253.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';
import { caseDbName, drainRetiredScratchDbs, retireScratchDb } from '../helpers/scratch-db.js';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));
const TAG = '0312_a_release_chain_replaces_the_release_model';

/** The statement list of 0312, and everything below it. */
function migrationParts(): { below: string[]; releaseChain: string[] } {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  const target = files.find((f) => f.sql.join('\n').includes('projects_release_chain_ok'));
  if (!target) throw new Error(`${TAG}.sql is not in the migrations folder`);
  const below = files
    .filter((f) => f.folderMillis < target.folderMillis)
    .sort((a, b) => a.folderMillis - b.folderMillis)
    .flatMap((f) => f.sql);
  return { below, releaseChain: target.sql };
}

export const { below, releaseChain } = migrationParts();

export interface PreMigrationGround {
  fresh(): Promise<{ sql: Sql; drop: () => Promise<void> }>;
  stop(): Promise<void>;
}

/** Build the template, and hand back a cloner for it. */
export async function preMigrationGround(): Promise<PreMigrationGround> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const template = caseDbName('iss1311tpl');
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
      const name = caseDbName('iss1311');
      await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
      const dbUrl = new URL(adminUrl);
      dbUrl.pathname = `/${name}`;
      const sql = postgres(dbUrl.toString(), { max: 1, onnotice: () => {} });
      return {
        sql,
        drop: async () => {
          await sql.end({ timeout: 5 }).catch(() => {});
          retireScratchDb(adminUrl, name);
        },
      };
    },
    async stop() {
      retireScratchDb(adminUrl, template);
      await drainRetiredScratchDbs();
      await admin.end({ timeout: 5 });
    },
  };
}

/** Run the forward migration as drizzle runs it: every statement, one transaction. */
export async function runForward(sql: Sql, statements: string[] = releaseChain): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of statements) await tx.unsafe(stmt, []);
  });
}

/**
 * The rollback, `drizzle/rollback/0312_down.sql`, run the way an operator runs it. Nothing else
 * here executes this file — `db/migrate.ts` never reads the folder — so until it is run here it is
 * a plan rather than the only way back from a migration that drops three columns.
 */
export async function runDown(sql: Sql): Promise<void> {
  const path = fileURLToPath(new URL('../../drizzle/rollback/0312_down.sql', import.meta.url));
  const statements = readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await sql.begin(async (tx) => {
    for (const stmt of statements) await tx.unsafe(stmt, []);
  });
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

export interface PlantedProject {
  id: string;
  slug: string;
}

/** A project at the PRE-0312 schema, as the four columns spelled it. `strategy` and `live` are
 *  written raw so a case can plant what 0312 refuses — a `tag-mr` row above all. */
export async function plantProject(
  sql: Sql,
  g: Ground,
  row: {
    slug: string;
    model: 'none' | 'promote' | 'publish';
    base?: string | null;
    live?: string | null;
    strategy?: string | null;
  },
): Promise<PlantedProject> {
  const id = randomUUID();
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, created_by, org_id, base_branch, live_branch,
                           release_model, release_strategy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      row.slug,
      row.slug,
      g.ownerId,
      g.orgId,
      row.base === undefined ? 'main' : row.base,
      row.live ?? null,
      row.model,
      row.strategy ?? null,
    ],
  );
  return { id, slug: row.slug };
}

/** The stored chain of one project, as the column holds it. */
export async function chainOf(sql: Sql, id: string): Promise<unknown> {
  const [row] = await sql.unsafe(`SELECT release_chain FROM projects WHERE id = $1`, [id]);
  return (row as unknown as { release_chain: unknown } | undefined)?.release_chain;
}

/** The four retired columns of one project, as the down migration restores them. */
export async function axesOf(
  sql: Sql,
  id: string,
): Promise<{
  base_branch: string | null;
  live_branch: string | null;
  release_model: string | null;
  release_strategy: string | null;
}> {
  const [row] = await sql.unsafe(
    `SELECT base_branch, live_branch, release_model, release_strategy FROM projects WHERE id = $1`,
    [id],
  );
  return row as unknown as {
    base_branch: string | null;
    live_branch: string | null;
    release_model: string | null;
    release_strategy: string | null;
  };
}

/**
 * Write a chain straight into the column, so the CHECK is the only thing judging it.
 *
 * `$1::text::jsonb` and not `$1::jsonb`: told the parameter is jsonb, postgres.js encodes the
 * value it is handed, so a pre-stringified `'[]'` arrives as the jsonb STRING `"[]"` and every
 * case reads a refusal the value never earned. Going through text makes the bytes sent the bytes
 * meant, and lets a case plant a jsonb `null`, which is not the same value as no chain at all.
 */
export async function writeChain(sql: Sql, id: string, chain: unknown): Promise<void> {
  await sql.unsafe(`UPDATE projects SET release_chain = $1::text::jsonb WHERE id = $2`, [
    JSON.stringify(chain),
    id,
  ]);
}
