/**
 * The harness `mcp-sentinel-migration.test.ts` runs against: a template database carrying every
 * migration BELOW 0255, cloned per case, plus the planting helpers each case builds its fleet from.
 *
 * Split out of the test file because that file crossed the 500-line budget and this half is the
 * part with no assertions in it. It keeps the `beforeAll`/`afterAll` that build and drop the
 * template: vitest collects hooks at import time, so they attach to whichever test file imports
 * this — one template per file, which is why there is exactly one such file.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));
const ROLLBACK_DIR = fileURLToPath(new URL('../../drizzle/rollback/', import.meta.url));

/**
 * The rollback file, found by what it SAYS rather than by its index — the index is positional
 * and a rebase renumbers it, so a hardcoded `0255_down.sql` would come to name another issue's
 * rollback, or nothing, which is the quieter of the two.
 */
function downFile(): string {
  const named = readdirSync(ROLLBACK_DIR)
    .filter((f) => f.endsWith('_down.sql'))
    .filter((f) =>
      readFileSync(`${ROLLBACK_DIR}${f}`, 'utf8').includes('iss1071_agent_access_set'),
    );
  const only = named[0];
  if (named.length !== 1 || !only) {
    throw new Error(
      `expected exactly one rollback file naming iss1071_agent_access_set, found ${named.length}`,
    );
  }
  return `${ROLLBACK_DIR}${only}`;
}

/** The statement list of 0255, and everything below it. */
function migrationParts(): { below: string[]; agentAccess: string[] } {
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  const target = files.find((f) => f.sql.join('\n').includes('iss1071_provider_agent_path'));
  if (!target) {
    throw new Error(
      'no migration declares iss1071_provider_agent_path — this file finds ISS-1071 by a table ' +
        'name rather than by an index, because the index moves at every rebase',
    );
  }
  const below = files
    .filter((f) => f.folderMillis < target.folderMillis)
    .sort((a, b) => a.folderMillis - b.folderMillis)
    .flatMap((f) => f.sql);
  return { below, agentAccess: target.sql };
}

const { below, agentAccess } = migrationParts();

export interface Fresh {
  sql: Sql;
  /** Every NOTICE the server raised on this connection, newest last. */
  notices: string[];
  drop: () => Promise<void>;
}

interface Ground {
  orgId: string;
  ownerId: string;
}

/** What `sql.json` will accept, which `Record<string, unknown>` is not. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

let adminUrl: string;
let admin: Sql;
let template: string;

beforeAll(async () => {
  adminUrl = process.env.TEST_PG_ADMIN_URL ?? process.env.TEST_DATABASE_URL ?? '';
  if (!adminUrl) throw new Error('no TEST_PG_ADMIN_URL — global setup did not run');
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  template = `iss1071_tpl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
}, 600_000);

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});

export async function fresh(): Promise<Fresh> {
  const name = `iss1071_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const notices: string[] = [];
  const sql = postgres(url.toString(), {
    max: 1,
    onnotice: (n: { message?: string }) => notices.push(n.message ?? String(n)),
  });
  return {
    sql,
    notices,
    drop: async () => {
      await sql.end({ timeout: 5 }).catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    },
  };
}

/** Run the forward migration as drizzle runs it: every statement, one transaction. */
export async function runForward(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of agentAccess) await tx.unsafe(stmt, []);
  });
}

/**
 * The rollback, run whole the way an operator runs it rather than split at drizzle's
 * breakpoints. Nothing else here executes it — `db/migrate.js` never reads the rollback
 * folder — so until this runs it is a plan, and it is the only way back from a dropped column.
 */
export async function runDown(sql: Sql): Promise<void> {
  try {
    await sql.unsafe(readFileSync(downFile(), 'utf8'));
  } catch (err) {
    // cm:why the file opens its own transaction, so a refusal leaves this connection inside an
    // ABORTED one and every later query answers `current transaction is aborted` — which would
    // hide whether the refusal changed anything, the only thing worth asserting about it. An
    // operator never sees this: `psql -v ON_ERROR_STOP=1` exits and the session goes with it.
    await sql.unsafe('ROLLBACK').catch(() => {});
    throw err;
  }
}

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
  slug: string,
  agentConfig: Record<string, Json> | null = null,
): Promise<string> {
  const id = randomUUID();
  // cm:guard `sql.json(...)`, never `JSON.stringify(...)::jsonb`: postgres-js serialises a
  // json-bound parameter itself, so a pre-stringified one is encoded TWICE and lands as a jsonb
  // string — `agent_config #> '{pipelineConfig,…}'` then answers NULL on every project and every
  // case here reads as the migration doing nothing. Measured; it cost the first full run.
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, created_by, org_id, agent_config, release_model)
     VALUES ($1, $2, $3, $4, $5, $6, 'none')`,
    [id, slug, slug, g.ownerId, g.orgId, agentConfig === null ? null : sql.json(agentConfig)],
  );
  return id;
}

/**
 * A binding and the connection under it. `secrets_enc IS NOT NULL` plus both `active` flags is
 * the whole of "this credential reaches an agent today", which is what the per-stage abort
 * reads; a case proving the boundary turns exactly one of the three off.
 */
interface BindingRow {
  projectId: string;
  provider: string;
  role?: 'deploy' | 'service';
  stages?: string[];
  label?: string;
  active?: boolean;
  connectionActive?: boolean;
  credential?: boolean;
}

export async function plantBinding(sql: Sql, g: Ground, row: BindingRow): Promise<string> {
  const id = randomUUID();
  const connectionId = randomUUID();
  const role = row.role ?? 'service';
  const stages = row.stages ?? (role === 'deploy' ? ['live'] : []);
  await sql.unsafe(
    `INSERT INTO integration_connections (id, owner_type, owner_id, provider, active, secrets_enc)
     VALUES ($1, 'user', $2, $3, $4, $5)`,
    [
      connectionId,
      g.ownerId,
      row.provider,
      row.connectionActive ?? true,
      row.credential === false ? null : Buffer.from('00112233445566778899aabb', 'hex'),
    ],
  );
  await sql.unsafe(
    `INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, stages, label, active)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8)`,
    [
      id,
      connectionId,
      row.projectId,
      row.provider,
      role,
      `{${stages.join(',')}}`,
      row.label ?? '',
      row.active ?? true,
    ],
  );
  return id;
}

export async function grantOf(sql: Sql, bindingId: string): Promise<string> {
  const rows = await sql.unsafe(`SELECT agent_access FROM integration_bindings WHERE id = $1`, [
    bindingId,
  ]);
  const row = rows[0];
  if (!row) throw new Error(`binding ${bindingId} is gone`);
  return row.agent_access as string;
}

/** The stored map at one scope, as jsonb's own canonical text. */
export async function mapAt(sql: Sql, projectId: string, scope: string): Promise<string | null> {
  const path =
    scope === 'default'
      ? `agent_config #> '{pipelineConfig,mcpServers}'`
      : `agent_config #> ARRAY['pipelineConfig','states','${scope}','mcpServers']`;
  const rows = await sql.unsafe(`SELECT (${path})::text AS m FROM projects WHERE id = $1`, [
    projectId,
  ]);
  return (rows[0]?.m as string | null) ?? null;
}

/**
 * Every project's whole `agent_config` as jsonb's canonical text, which is what makes the
 * rollback's "byte for byte" claim checkable: jsonb normalises key order on the way in, so
 * equal text IS equal value, and a `false` restored as `true` changes the string.
 */
export async function allConfigs(sql: Sql): Promise<Record<string, string | null>> {
  const rows = await sql.unsafe(
    `SELECT slug, agent_config::text AS cfg FROM projects ORDER BY slug`,
  );
  return Object.fromEntries(rows.map((r) => [r.slug as string, (r.cfg as string | null) ?? null]));
}

/** A pipelineConfig carrying a project-default map, and optionally per-stage maps. */
export function config(
  mcpServers: Record<string, Json> | null,
  states?: Record<string, Record<string, Json>>,
): Record<string, Json> {
  const pipelineConfig: Record<string, Json> = {};
  if (mcpServers) pipelineConfig.mcpServers = mcpServers;
  if (states) {
    pipelineConfig.states = Object.fromEntries(
      Object.entries(states).map(([k, v]) => [k, { mcpServers: v }]),
    );
  }
  return { pipelineConfig };
}

/** The object spec a person writes by hand for a server the catalog does not carry. */
export const CUSTOM_SPEC = { type: 'stdio', command: 'npx', args: ['some-server@latest'], env: {} };

/**
 * The fleet every non-refusing case stands on, planted once and read many times.
 *
 * One table rather than one block per case, because each row's comment IS the case it exists
 * for: read the row and the assertion below it names the same shape.
 */
const WIDE: ReadonlyArray<{
  slug: string;
  cfg: Record<string, Json> | null;
  bindings: ReadonlyArray<[key: string, row: Omit<BindingRow, 'projectId'>]>;
}> = [
  // A project that opted itself into its storefront at the project default.
  {
    slug: 'shop',
    cfg: config({ epodsystem: true }),
    bindings: [['shopEpod', { provider: 'epodsystem' }]],
  },
  // Core-mediated bindings and no sentinel anywhere: today both answer any project member's
  // agent through a core tool with no gate at all, so `none` would take a path away.
  {
    slug: 'deployer',
    cfg: null,
    bindings: [
      ['coolify', { provider: 'coolify', role: 'deploy', stages: ['live'] }],
      ['google', { provider: 'google' }],
    ],
  },
  // A direct-MCP binding nobody declared, beside the two providers with no agent path at all.
  {
    slug: 'quiet',
    cfg: config({ playwright: true }),
    bindings: [
      ['postman', { provider: 'postman' }],
      ['rocketchat', { provider: 'rocketchat' }],
      ['github', { provider: 'github' }],
    ],
  },
  // A stage-only sentinel over NO binding — representable, so it must not abort.
  { slug: 'stage-only', cfg: config(null, { developed: { sentry: true } }), bindings: [] },
  // A per-stage `false`: a switch somebody turned off, still a sentinel, still has to go.
  {
    slug: 'switched-off',
    cfg: config(null, { testing: { postman: false } }),
    bindings: [['switchedOffPostman', { provider: 'postman' }]],
  },
  // A labelled epodsystem sentinel over the binding it names.
  {
    slug: 'two-stores',
    cfg: config({ epodsystem_store_a: true }),
    bindings: [['storeA', { provider: 'epodsystem', label: 'store-a' }]],
  },
  // Names this migration must not touch: a catalog server, a hand-written object spec, and an
  // object stored UNDER an integration name — a custom server, not a sentinel.
  {
    slug: 'custom',
    cfg: config({ playwright: true, 'my-own-server': CUSTOM_SPEC, postman: CUSTOM_SPEC }),
    bindings: [['customPostman', { provider: 'postman' }]],
  },
];

export interface Wide {
  f: Fresh;
  project: Record<string, string>;
  binding: Record<string, string>;
}

export async function plantWide(f: Fresh): Promise<Wide> {
  const g = await ground(f.sql);
  const project: Record<string, string> = {};
  const binding: Record<string, string> = {};
  for (const row of WIDE) {
    const projectId = await plantProject(f.sql, g, row.slug, row.cfg);
    project[row.slug] = projectId;
    for (const [key, spec] of row.bindings) {
      binding[key] = await plantBinding(f.sql, g, { ...spec, projectId });
    }
  }
  return { f, project, binding };
}
