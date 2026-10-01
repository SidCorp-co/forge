/**
 * ISS-16 — `scripts/export-legacy-project-config.mjs` against the database it exists for: one still
 * at the schema before migration `the_legacy_project_columns_are_dropped`, holding every legacy column. The harness database is
 * already past it, so the old schema is rebuilt from every migration below it.
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caseDbName, drainRetiredScratchDbs, retireScratchDb } from '../helpers/scratch-db.js';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));
const SCRIPT = fileURLToPath(
  new URL('../../../../scripts/export-legacy-project-config.mjs', import.meta.url),
);
const PASSWORD = 'hunter2-do-not-print';
const MCP_TOKEN = 'ghp_mcp-token-do-not-print';

type Exporter = typeof import('../../../../scripts/export-legacy-project-config.mjs');

function migrationParts() {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS }).sort(
    (a, b) => a.folderMillis - b.folderMillis,
  );
  const drop = files.find((f) => f.sql.join('\n').includes('DROP COLUMN "workspace_setup"'));
  if (!drop) throw new Error('the migration dropping the legacy project columns is not in the folder');
  return {
    below: files.filter((f) => f.folderMillis < drop.folderMillis).flatMap((f) => f.sql),
    drop: drop.sql,
  };
}

const { below, drop } = migrationParts();

let admin: Sql;
let adminUrl: string;
let dbName: string;
let url: string;
let sql: Sql;
let exporter: Exporter;
let full: string;

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, '--url', url, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function fingerprint(): Promise<string> {
  const [row] = await sql.unsafe(`
    SELECT md5(coalesce((SELECT string_agg(p::text, '|' ORDER BY p.id) FROM projects p), '')
           || coalesce((SELECT string_agg(b::text, '|' ORDER BY b.id) FROM integration_bindings b), ''))
           AS h
  `);
  return (row as unknown as { h: string }).h;
}

beforeAll(async () => {
  adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  dbName = caseDbName('iss16export');
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  url = u.toString();
  sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.begin(async (tx) => {
    for (const stmt of below) await tx.unsafe(stmt, []);
  });
  // cm:why beta's database is older than this tree's 0327 and 0329: it still holds the binding's
  // `stages` and the project's `repo_path`, which the export must read too.
  await sql.unsafe(`ALTER TABLE integration_bindings ADD COLUMN stages text[] NOT NULL DEFAULT '{}'`);
  await sql.unsafe(`ALTER TABLE projects ADD COLUMN repo_path text`);

  const owner = randomUUID();
  const org = randomUUID();
  full = randomUUID();
  await sql.unsafe(
    `INSERT INTO users (id, email, password_hash, kind) VALUES ($1, $2, '!x', 'human')`,
    [owner, `owner-${owner}@test.forge.local`],
  );
  await sql.unsafe(
    `INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES ($1, $2, 'Org', false, $3)`,
    [org, `org-${org.slice(0, 8)}`, owner],
  );
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, org_id, created_by, description, kind, repo_url,
                           workspace_setup, release_chain, environments, agent_config, repo_path)
     VALUES ($1, 'alpha', 'Alpha', $2, $3, 'the storefront', 'website',
             'git@github.com:acme/alpha.git', 'pnpm install', $4::text::jsonb, $5::text::jsonb,
             $6::text::jsonb, '/srv/alpha')`,
    [
      full,
      org,
      owner,
      JSON.stringify([{ branch: 'staging' }, { branch: 'main', from: 'merge-branch' }]),
      JSON.stringify({
        live: {
          url: 'https://alpha.example',
          testCredentials: [{ label: 'admin', username: 'ops@acme', password: PASSWORD }],
        },
      }),
      JSON.stringify({
        plugins: [{ marketplace: 'acme/market', name: 'kit' }],
        mcpServers: { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: MCP_TOKEN } } },
      }),
    ],
  );
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, org_id, created_by) VALUES ($1, 'bravo', 'Bravo', $2, $3)`,
    [randomUUID(), org, owner],
  );
  const connection = randomUUID();
  await sql.unsafe(
    `INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, active)
     VALUES ($1, 'user', $2, 'coolify', '{}'::jsonb, true)`,
    [connection, owner],
  );
  await sql.unsafe(
    `INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, label, active, config, stages)
     VALUES ($1, $2, $3, 'coolify', 'deploy', '', true, '{}'::jsonb, ARRAY['live'])`,
    [randomUUID(), connection, full],
  );

  exporter = await import('../../../../scripts/export-legacy-project-config.mjs');
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  if (dbName) retireScratchDb(adminUrl, dbName);
  await drainRetiredScratchDbs();
  await admin?.end({ timeout: 5 });
});

describe('the export on a database still at the old schema', () => {
  it('reads every legacy column of every project, and writes nothing', async () => {
    const before = await fingerprint();
    const out = run('--json');
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as {
      columns: Array<{ table: string; column: string; present: boolean }>;
      projects: Array<{
        slug: string;
        legacy: Record<string, unknown>;
        bindings: Array<{ role: string; stages: string[] }>;
      }>;
    };

    const present = report.columns.filter((c) => c.present).map((c) => `${c.table}.${c.column}`);
    expect(present).toEqual(
      expect.arrayContaining([
        'projects.description',
        'projects.kind',
        'projects.repo_url',
        'projects.workspace_setup',
        'projects.release_chain',
        'projects.environments',
        'projects.agent_config',
      ]),
    );
    expect(report.columns.find((c) => c.column === 'default_device_id')?.present).toBe(false);

    const alpha = report.projects.find((p) => p.slug === 'alpha');
    expect(alpha?.legacy).toMatchObject({
      description: 'the storefront',
      kind: 'website',
      repo_url: 'git@github.com:acme/alpha.git',
      workspace_setup: 'pnpm install',
      repo_path: '/srv/alpha',
      release_chain: [{ branch: 'staging' }, { branch: 'main', from: 'merge-branch' }],
      environments: {
        live: {
          url: 'https://alpha.example',
          testCredentials: [{ label: 'admin', credential: exporter.SECRET_MARK }],
        },
      },
      agent_config: {
        plugins: [{ marketplace: 'acme/market', name: 'kit' }],
        mcpServers: { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: exporter.SECRET_MARK } } },
      },
    });
    expect(report.projects.find((p) => p.slug === 'bravo')?.legacy).toMatchObject({
      description: null,
      kind: 'standard',
      repo_url: null,
    });
    expect(report.projects.find((p) => p.slug === 'bravo')?.legacy).not.toHaveProperty(
      'default_device_id',
    );
    expect(alpha?.bindings).toEqual([expect.objectContaining({ role: 'deploy', stages: ['live'] })]);

    expect(out.stdout).not.toContain(PASSWORD);
    expect(out.stdout).not.toContain(MCP_TOKEN);
    expect(out.stdout).not.toContain('ops@acme');
    expect(await fingerprint()).toBe(before);
  });

  it('prints the same for a person, naming what each column is re-entered as and what is absent', () => {
    const out = run();
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/present {2}projects\.repo_url {2}→ re-enter as source\.git\.repository/);
    expect(out.stdout).toMatch(
      /absent {3}projects\.default_device_id {2}\(this database does not hold it/,
    );
    expect(out.stdout).toContain('project alpha (');
    expect(out.stdout).toContain('repo_url: git@github.com:acme/alpha.git');
    expect(out.stdout).toContain('stages=["live"]');
    expect(out.stdout).toContain(exporter.SECRET_MARK);
    expect(out.stdout).not.toContain(PASSWORD);
    const db = new URL(url);
    expect(out.stdout.split('\n')[0]).toBe(
      `export-legacy-project-config: ${db.hostname}:${db.port}${db.pathname} (read-only)`,
    );
  });

  it('opens a session that refuses a planted write, inside the transaction and outside it', async () => {
    const before = await fingerprint();
    await expect(
      exporter.withReadOnly(url, (tx: Sql) => tx`UPDATE projects SET name = 'planted' WHERE slug = 'alpha'`),
    ).rejects.toMatchObject({ code: '25006' });
    const settings = await exporter.withReadOnly(url, async (tx: Sql) => {
      const [session] = await tx`SHOW default_transaction_read_only`;
      const [txn] = await tx`SHOW transaction_read_only`;
      return { session, txn };
    });
    expect(settings).toEqual({
      session: { default_transaction_read_only: 'on' },
      txn: { transaction_read_only: 'on' },
    });
    expect(await fingerprint()).toBe(before);
  });

  it('names each column the drop migration removed as absent, and says plainly when none is left', async () => {
    await sql.begin(async (tx) => {
      for (const stmt of drop) await tx.unsafe(stmt, []);
    });
    const after = run();
    expect(after.status).toBe(0);
    for (const column of ['description', 'kind', 'repo_url', 'workspace_setup', 'release_chain']) {
      expect(after.stdout).toMatch(new RegExp(`absent {3}projects\\.${column} `));
    }
    expect(after.stdout).toMatch(/present {2}projects\.agent_config/);

    await sql.unsafe('ALTER TABLE projects DROP COLUMN repo_path, DROP COLUMN agent_config');
    await sql.unsafe('ALTER TABLE integration_bindings DROP COLUMN stages');
    const none = run();
    expect(none.status).toBe(0);
    expect(none.stdout).toContain(
      'No legacy column exists in this database, so there is no old config to export.',
    );
  });

  it('refuses to run with no database named, and exits 2', () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no database named');
  });
});
