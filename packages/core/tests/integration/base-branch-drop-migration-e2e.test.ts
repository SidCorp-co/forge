/**
 * `0336_the_branch_and_the_project_secrets_leave_the_row.sql` drops `projects.base_branch` only
 * where the project document already carries the same branch as `source.git.defaultBranch`. Every
 * other project aborts the deploy, named. The ground is a database at every migration below 0336,
 * because the harness's own database is already past it and has no column left to plant into.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseDbName, drainRetiredScratchDbs, retireScratchDb } from '../helpers/scratch-db.js';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));
const TAG = '0336_the_branch_and_the_project_secrets_leave_the_row';

const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
const target = files.find((f) =>
  f.sql.join('\n').includes('projects.base_branch cannot be dropped'),
);
if (!target) throw new Error(`${TAG}.sql is not in the migrations folder`);
const below = files
  .filter((f) => f.folderMillis < target.folderMillis)
  .sort((a, b) => a.folderMillis - b.folderMillis)
  .flatMap((f) => f.sql);

const adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
let admin: Sql;
let template: string;

beforeAll(async () => {
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  template = caseDbName('iss16tpl');
  await admin.unsafe(`CREATE DATABASE "${template}"`);
  const tpl = postgres(urlOf(template), { max: 1, onnotice: () => {} });
  try {
    await tpl.begin(async (tx) => {
      for (const stmt of below) await tx.unsafe(stmt, []);
    });
  } finally {
    await tpl.end({ timeout: 5 });
  }
}, 240_000);

afterAll(async () => {
  retireScratchDb(adminUrl, template);
  await drainRetiredScratchDbs();
  await admin.end({ timeout: 5 });
});

function urlOf(name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function fresh(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const name = caseDbName('iss16');
  await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const sql = postgres(urlOf(name), { max: 1, onnotice: () => {} });
  return {
    sql,
    drop: async () => {
      await sql.end({ timeout: 5 }).catch(() => {});
      retireScratchDb(adminUrl, name);
    },
  };
}

type Source = { type: 'git'; defaultBranch: string } | { type: 'none' | 'storefront' } | null;

/** A project at the pre-0336 schema, with the branch column and, optionally, a document. */
async function plant(sql: Sql, slug: string, base: string | null, source: Source): Promise<void> {
  const ownerId = randomUUID();
  const orgId = randomUUID();
  const id = randomUUID();
  await sql.unsafe(
    `INSERT INTO users (id, email, kind, email_verified_at) VALUES ($1, $2, 'human', now())`,
    [ownerId, `${slug}@example.com`],
  );
  await sql.unsafe(
    `INSERT INTO organizations (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`,
    [orgId, slug, `org-${slug}`, ownerId],
  );
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, created_by, org_id, base_branch, webhook_secret, api_key)
     VALUES ($1, $2, $2, $3, $4, $5, 'whs-planted-value', $6)`,
    [id, slug, ownerId, orgId, base, `fk_${slug}`],
  );
  if (source === null) return;
  const document =
    source.type === 'git'
      ? { source: { type: 'git', git: { defaultBranch: source.defaultBranch } } }
      : { source: { type: source.type } };
  await sql.unsafe(
    `INSERT INTO project_config_documents (project_id, revision, document, updated_by)
     VALUES ($1, 1, $2::text::jsonb, $3)`,
    [id, JSON.stringify(document), ownerId],
  );
}

async function forward(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of target?.sql ?? []) await tx.unsafe(stmt, []);
  });
}

async function columns(sql: Sql): Promise<string[]> {
  const rows = await sql.unsafe(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name IN ('base_branch', 'webhook_secret', 'api_key')`,
  );
  return rows.map((r) => (r as unknown as { column_name: string }).column_name);
}

describe(`${TAG}`, () => {
  it('drops the three columns where every git document declares the same branch and the rest have no git', async () => {
    const { sql, drop } = await fresh();
    try {
      await plant(sql, 'agreed', 'main', { type: 'git', defaultBranch: 'main' });
      await plant(sql, 'unset', null, null);
      await plant(sql, 'no-git', 'main', { type: 'none' });
      await plant(sql, 'storefront', 'main', { type: 'storefront' });
      await forward(sql);
      expect(await columns(sql)).toEqual([]);
    } finally {
      await drop();
    }
  });

  it('aborts naming the project whose column holds a branch and that has no document', async () => {
    const { sql, drop } = await fresh();
    try {
      await plant(sql, 'agreed', 'main', { type: 'git', defaultBranch: 'main' });
      await plant(sql, 'undeclared', 'main', null);
      await expect(forward(sql)).rejects.toThrow(
        /projects\.base_branch cannot be dropped: undeclared \([0-9a-f-]+\): base_branch 'main', document defaultBranch NULL/,
      );
      expect((await columns(sql)).sort()).toEqual(['api_key', 'base_branch', 'webhook_secret']);
    } finally {
      await drop();
    }
  });

  it('aborts naming both values where the document declares another branch', async () => {
    const { sql, drop } = await fresh();
    try {
      await plant(sql, 'drifted', 'dev', { type: 'git', defaultBranch: 'main' });
      await expect(forward(sql)).rejects.toThrow(
        /drifted \([0-9a-f-]+\): base_branch 'dev', document defaultBranch 'main'.*PUT \/api\/projects\/:id\/config/,
      );
    } finally {
      await drop();
    }
  });
});
