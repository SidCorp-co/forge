/**
 * ISS-1071 — what `0255_integration_agent_access.sql` does, walked against a real Postgres.
 *
 * The migration turns a sentinel key in `pipelineConfig.mcpServers` into one column on the
 * binding, and the only interesting question is what it does to reachability: a grant it
 * closes is a path somebody had, and a grant it opens is a credential somebody did not offer.
 * So every case below is about a row's reachability BEFORE and AFTER, never about whether the
 * statement ran.
 *
 * Two of them are refusals, and those are the deliverable rather than the exception: a
 * provider the file's vocabulary does not classify, and a per-stage grant a binary column
 * cannot represent. Beside each sits its boundary — the shape that must NOT abort — because
 * an over-broad abort is what crash-looped the beta API for 85 minutes on 0253, and a refusal
 * with no case proving where it stops is a refusal nobody can trust to be narrow.
 *
 * The ground is `conversations-migration-ground.ts` / `release-axes-migration-ground.ts`: a
 * template carrying every migration BELOW this one, cloned per case. It has to be, because
 * the harness's own database is already migrated PAST 0255 and there is no way to plant a
 * sentinel into a map the migration has already stripped.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle/migrations', import.meta.url));
const ROLLBACK_DIR = fileURLToPath(new URL('../../drizzle/rollback/', import.meta.url));

/**
 * This migration's rollback file, found by what it SAYS rather than by its index.
 *
 * The index is positional: a rebase past another migration renumbers the `.sql`, the journal
 * entry and the snapshot, and a path spelled `0255_down.sql` here would then point at another
 * issue's rollback or at nothing — and pointing at nothing is the quieter of the two.
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

interface Fresh {
  sql: Sql;
  /** Every NOTICE the server raised on this connection, newest last. */
  notices: string[];
  drop: () => Promise<void>;
}

interface Ground {
  orgId: string;
  ownerId: string;
}

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

async function fresh(): Promise<Fresh> {
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
async function runForward(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    for (const stmt of agentAccess) await tx.unsafe(stmt, []);
  });
}

/**
 * The rollback, run the way an operator runs it — whole, with its own BEGIN/COMMIT, rather
 * than split at drizzle's statement breakpoints.
 *
 * Nothing else in this repository executes this file: `db/migrate.js` never reads the
 * rollback folder. Until it is run here it is a plan rather than a way back, and it is the
 * only way back from a migration that drops a column.
 */
async function runDown(sql: Sql): Promise<void> {
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

async function ground(sql: Sql): Promise<Ground> {
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

async function plantProject(
  sql: Sql,
  g: Ground,
  slug: string,
  agentConfig: Record<string, unknown> | null = null,
): Promise<string> {
  const id = randomUUID();
  // cm:guard the config goes in as an OBJECT, never as `JSON.stringify(...)::jsonb`. postgres-js
  // serialises a parameter bound to a json column itself, so a pre-stringified one is encoded
  // twice and lands as a jsonb STRING containing JSON — `agent_config #> '{pipelineConfig,...}'`
  // then answers NULL on every project and every case here reads as the migration doing nothing.
  await sql.unsafe(
    `INSERT INTO projects (id, slug, name, created_by, org_id, agent_config, release_model)
     VALUES ($1, $2, $3, $4, $5, $6, 'none')`,
    [id, slug, slug, g.ownerId, g.orgId, agentConfig === null ? null : sql.json(agentConfig)],
  );
  return id;
}

/**
 * A binding and the connection under it.
 *
 * `credential` is what section 5's abort reads — `secrets_enc IS NOT NULL` together with both
 * `active` flags is the whole of "this credential reaches an agent today", and a case meaning
 * to prove the boundary turns exactly one of the three off.
 */
async function plantBinding(
  sql: Sql,
  g: Ground,
  row: {
    projectId: string;
    provider: string;
    role?: 'deploy' | 'service';
    stages?: string[];
    label?: string;
    active?: boolean;
    connectionActive?: boolean;
    credential?: boolean;
  },
): Promise<string> {
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

async function grantOf(sql: Sql, bindingId: string): Promise<string> {
  const rows = await sql.unsafe(`SELECT agent_access FROM integration_bindings WHERE id = $1`, [
    bindingId,
  ]);
  const row = rows[0];
  if (!row) throw new Error(`binding ${bindingId} is gone`);
  return row.agent_access as string;
}

/** The stored map at one scope, as jsonb's own canonical text. */
async function mapAt(sql: Sql, projectId: string, scope: string): Promise<string | null> {
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
 * Every project's whole `agent_config`, in jsonb's canonical text — which is what makes the
 * rollback's "byte for byte" claim checkable at all. jsonb normalises key order and number
 * formatting on the way in, so two maps that print the same text ARE the same value, and one
 * key restored under a different name or a `false` restored as `true` changes the string.
 */
async function allConfigs(sql: Sql): Promise<Record<string, string | null>> {
  const rows = await sql.unsafe(
    `SELECT slug, agent_config::text AS cfg FROM projects ORDER BY slug`,
  );
  return Object.fromEntries(rows.map((r) => [r.slug as string, (r.cfg as string | null) ?? null]));
}

/** A pipelineConfig carrying a project-default map, and optionally per-stage maps. */
function config(
  mcpServers: Record<string, unknown> | null,
  states?: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const pipelineConfig: Record<string, unknown> = {};
  if (mcpServers) pipelineConfig.mcpServers = mcpServers;
  if (states) {
    pipelineConfig.states = Object.fromEntries(
      Object.entries(states).map(([k, v]) => [k, { mcpServers: v }]),
    );
  }
  return { pipelineConfig };
}

/** The object spec a person writes by hand for a server the catalog does not carry. */
const CUSTOM_SPEC = { type: 'stdio', command: 'npx', args: ['some-server@latest'], env: {} };

// ===========================================================================
// The fleet every non-refusing case stands on, planted once and read many times.
// ===========================================================================

interface Wide {
  f: Fresh;
  g: Ground;
  project: Record<string, string>;
  binding: Record<string, string>;
}

async function plantWide(f: Fresh): Promise<Wide> {
  const g = await ground(f.sql);
  const project: Record<string, string> = {};
  const binding: Record<string, string> = {};

  // A project that opted itself into its storefront at the project default.
  project.shop = await plantProject(f.sql, g, 'shop', config({ epodsystem: true }));
  binding.shopEpod = await plantBinding(f.sql, g, {
    projectId: project.shop,
    provider: 'epodsystem',
  });

  // A project with core-mediated bindings and no sentinel anywhere — today both answer any
  // project member's agent with no gate at all.
  project.deployer = await plantProject(f.sql, g, 'deployer', config(null));
  binding.coolify = await plantBinding(f.sql, g, {
    projectId: project.deployer,
    provider: 'coolify',
    role: 'deploy',
    stages: ['live'],
  });
  binding.google = await plantBinding(f.sql, g, {
    projectId: project.deployer,
    provider: 'google',
  });

  // A direct-MCP binding nobody declared, and the two providers with no agent path at all.
  project.quiet = await plantProject(f.sql, g, 'quiet', config({ playwright: true }));
  binding.postman = await plantBinding(f.sql, g, {
    projectId: project.quiet,
    provider: 'postman',
  });
  binding.rocketchat = await plantBinding(f.sql, g, {
    projectId: project.quiet,
    provider: 'rocketchat',
  });
  binding.github = await plantBinding(f.sql, g, {
    projectId: project.quiet,
    provider: 'github',
  });

  // A stage-only sentinel over NO live binding — representable, so it must not abort.
  project.stageOnly = await plantProject(
    f.sql,
    g,
    'stage-only',
    config(null, { developed: { sentry: true } }),
  );

  // A per-stage `false` — a switch somebody turned off, still a sentinel, still has to go.
  project.switchedOff = await plantProject(
    f.sql,
    g,
    'switched-off',
    config(null, { testing: { postman: false } }),
  );
  binding.switchedOffPostman = await plantBinding(f.sql, g, {
    projectId: project.switchedOff,
    provider: 'postman',
  });

  // A labelled epodsystem sentinel, and the two bindings it reaches.
  project.twoStores = await plantProject(
    f.sql,
    g,
    'two-stores',
    config({ epodsystem_store_a: true }),
  );
  binding.storeA = await plantBinding(f.sql, g, {
    projectId: project.twoStores,
    provider: 'epodsystem',
    label: 'store-a',
  });

  // Names this migration must not touch: a catalog server, a custom object spec, and an
  // object stored UNDER an integration name, which is a custom server and not a sentinel.
  project.custom = await plantProject(
    f.sql,
    g,
    'custom',
    config({ playwright: true, 'my-own-server': CUSTOM_SPEC, postman: CUSTOM_SPEC }),
  );
  binding.customPostman = await plantBinding(f.sql, g, {
    projectId: project.custom,
    provider: 'postman',
  });

  return { f, g, project, binding };
}

describe('0255 forward — reachability is preserved row by row', () => {
  let w: Wide;

  beforeAll(async () => {
    w = await plantWide(await fresh());
    await runForward(w.f.sql);
  }, 120_000);

  afterAll(async () => {
    if (w) await w.f.drop();
  });

  it('grants a project-default sentinel over a live epodsystem credential', async () => {
    expect(await grantOf(w.f.sql, w.binding.shopEpod ?? '')).toBe('all');
  });

  // cm:guard `none` here would not preserve a state, it would TAKE AWAY a path that is open:
  // `forge_coolify_deploy` answers any project member's agent today with nothing to read.
  it('grants a coolify binding that declared nothing, and says so in the deploy log', async () => {
    expect(await grantOf(w.f.sql, w.binding.coolify ?? '')).toBe('all');
    const forced = w.f.notices.filter((n) => /by FORCE/.test(n)).join('\n');
    expect(forced).toContain(w.binding.coolify ?? 'no-binding');
    expect(forced).toContain('deployer');
    expect(forced).toContain('coolify');
  });

  it('grants a google binding that declared nothing', async () => {
    expect(await grantOf(w.f.sql, w.binding.google ?? '')).toBe('all');
  });

  it('leaves a postman binding nobody declared closed', async () => {
    expect(await grantOf(w.f.sql, w.binding.postman ?? '')).toBe('none');
  });

  it('leaves a provider with no agent path closed', async () => {
    expect(await grantOf(w.f.sql, w.binding.rocketchat ?? '')).toBe('none');
    expect(await grantOf(w.f.sql, w.binding.github ?? '')).toBe('none');
  });

  // cm:guard the BOUNDARY of section 5's abort. Nothing was reachable — no binding at all —
  // so `none` is exactly what was true and the sentinel is simply removed. An abort here
  // would be the over-broad abort that crash-loops a deploy.
  it('accepts a stage-only sentinel over no binding, and removes it', async () => {
    expect(await mapAt(w.f.sql, w.project.stageOnly ?? '', 'developed')).toBe('{}');
  });

  it('removes a per-stage `false`, and records it in the before-image', async () => {
    expect(await mapAt(w.f.sql, w.project.switchedOff ?? '', 'testing')).toBe('{}');
    expect(await grantOf(w.f.sql, w.binding.switchedOffPostman ?? '')).toBe('none');
    const rows = await w.f.sql.unsafe(
      `SELECT scope, server_name, value::text AS v FROM iss1071_removed_mcp_sentinels
        WHERE project_id = $1`,
      [w.project.switchedOff ?? ''],
    );
    expect(rows.map((r) => `${r.scope}/${r.server_name}=${r.v}`)).toEqual([
      'testing/postman=false',
    ]);
  });

  it('grants and removes an `epodsystem_<label>` sentinel', async () => {
    expect(await grantOf(w.f.sql, w.binding.storeA ?? '')).toBe('all');
    expect(await mapAt(w.f.sql, w.project.twoStores ?? '', 'default')).toBe('{}');
  });

  // cm:guard only a literal boolean is the shorthand. An object under an integration name is
  // a custom server somebody hand-wrote — `isIntegrationSentinelName` is about the NAME, and
  // reading the name alone would delete a working server spec and grant on it at once.
  it('leaves a catalog name and every object spec alone, including one named `postman`', async () => {
    const stored = await mapAt(w.f.sql, w.project.custom ?? '', 'default');
    expect(JSON.parse(stored ?? 'null')).toEqual({
      playwright: true,
      'my-own-server': CUSTOM_SPEC,
      postman: CUSTOM_SPEC,
    });
    expect(await grantOf(w.f.sql, w.binding.customPostman ?? '')).toBe('none');
  });
});

describe('0255 forward — what it refuses, and where the refusal stops', () => {
  // cm:guard the refusal IS the deliverable. There is no safe default for a provider whose
  // agent path this file cannot read: `none` silently closes a path that is open, `all`
  // silently writes a credential onto a runner box.
  it('aborts naming a provider its vocabulary does not classify', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(f.sql, g, 'newcomer', config(null));
      await plantBinding(f.sql, g, { projectId, provider: 'linear' });

      await expect(runForward(f.sql)).rejects.toThrow(/linear/);

      const cols = await f.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
      );
      expect(cols.map((c) => c.column_name as string)).not.toContain('agent_access');
    } finally {
      await f.drop();
    }
  });

  // cm:guard the one shape a binary column cannot hold: the credential reaches ONE stage
  // today. `all` widens a live credential to stages that never had it; `none` breaks a lane
  // somebody is working in. Neither is preservation, so the migration stops and asks.
  it('aborts naming the project and provider of a per-stage grant it cannot represent', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(
        f.sql,
        g,
        'scoped-lane',
        config(null, { developed: { sentry: true } }),
      );
      await plantBinding(f.sql, g, { projectId, provider: 'sentry' });

      const err = await runForward(f.sql).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(err).toMatch(/scoped-lane/);
      expect(err).toMatch(/sentry/);
      expect(err).toMatch(/developed/);
    } finally {
      await f.drop();
    }
  });

  // cm:guard the same stage-only sentinel, one flag at a time off the binding. Each of these
  // is a lane that is NOT open today, so nothing is taken away by leaving the grant closed —
  // and an abort that fired on any of them would be the over-broad abort 0253 paid for.
  it.each([
    ['the binding is inactive', { active: false }],
    ['the connection is inactive', { connectionActive: false }],
    ['the connection holds no credential', { credential: false }],
  ])('does not abort on a per-stage grant where %s', async (_name, flags) => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(
        f.sql,
        g,
        'dormant',
        config(null, { developed: { sentry: true } }),
      );
      const bindingId = await plantBinding(f.sql, g, {
        projectId,
        provider: 'sentry',
        ...flags,
      });

      await runForward(f.sql);

      expect(await grantOf(f.sql, bindingId)).toBe('none');
      expect(await mapAt(f.sql, projectId, 'developed')).toBe('{}');
    } finally {
      await f.drop();
    }
  });

  // cm:guard a project default beside the stage declaration is NOT the unrepresentable shape:
  // the project already opts in everywhere, so `all` is what is true and the stage entry adds
  // nothing a column has to carry.
  it('does not abort where the project default declares the same provider', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(
        f.sql,
        g,
        'default-and-stage',
        config({ sentry: true }, { developed: { sentry: true } }),
      );
      const bindingId = await plantBinding(f.sql, g, { projectId, provider: 'sentry' });

      await runForward(f.sql);

      expect(await grantOf(f.sql, bindingId)).toBe('all');
      expect(await mapAt(f.sql, projectId, 'default')).toBe('{}');
      expect(await mapAt(f.sql, projectId, 'developed')).toBe('{}');
    } finally {
      await f.drop();
    }
  });
});

describe('0255_down.sql — the way back', () => {
  it('restores every stored map to exactly what the forward run found', async () => {
    const f = await fresh();
    try {
      const w = await plantWide(f);
      const before = await allConfigs(f.sql);

      await runForward(f.sql);
      const stripped = await allConfigs(f.sql);
      // The rollback is only worth proving if the forward run moved something.
      expect(stripped).not.toEqual(before);
      expect(await grantOf(f.sql, w.binding.shopEpod ?? '')).toBe('all');

      await runDown(f.sql);

      expect(await allConfigs(f.sql)).toEqual(before);
      const cols = await f.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
      );
      expect(cols.map((c) => c.column_name as string)).not.toContain('agent_access');
    } finally {
      await f.drop();
    }
  }, 120_000);

  // cm:guard the image is a photograph of one moment, and a grant changed since is a decision
  // it cannot speak for: the map it would restore is not the state that grant came from, and
  // the column is about to be dropped, so nothing would record that the decision existed.
  it('refuses by name, changing nothing, when a grant moved after the forward run', async () => {
    const f = await fresh();
    try {
      const g = await ground(f.sql);
      const projectId = await plantProject(f.sql, g, 'moved-on', config({ postman: true }));
      const bindingId = await plantBinding(f.sql, g, { projectId, provider: 'postman' });

      await runForward(f.sql);
      expect(await grantOf(f.sql, bindingId)).toBe('all');
      const stripped = await allConfigs(f.sql);

      await f.sql.unsafe(`UPDATE integration_bindings SET agent_access = 'none' WHERE id = $1`, [
        bindingId,
      ]);

      const err = await runDown(f.sql).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(err).toMatch(new RegExp(bindingId));
      expect(err).toMatch(/moved-on/);
      expect(err).toMatch(/postman/);

      // changed nothing: the column is still there and the map is still stripped
      const cols = await f.sql.unsafe(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_bindings'`,
      );
      expect(cols.map((c) => c.column_name as string)).toContain('agent_access');
      expect(await allConfigs(f.sql)).toEqual(stripped);
    } finally {
      await f.drop();
    }
  });
});
