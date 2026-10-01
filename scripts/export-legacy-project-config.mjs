#!/usr/bin/env node

/**
 * Prints each project's config as the legacy `projects` columns hold it, and every integration
 * binding's label and free-text rollback, so the projects can be re-entered by hand through the v1
 * API after the release that drops them (ISS-16, design D8).
 * Read-only: the session refuses writes (`default_transaction_read_only`) and the read is one
 * `READ ONLY` transaction. Secrets print as names only. It reads raw columns with SQL and imports
 * nothing from core, because it runs against a database whose schema core no longer describes.
 * Usage: DATABASE_URL=… node scripts/export-legacy-project-config.mjs [--json] [--url <url>]
 * Exit 0 printed (also when no legacy column exists) · 2 could not run.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const LABEL = 'export-legacy-project-config';
export const SECRET_MARK = 'present, re-enter as a project secret';
export const DISCARDED_MARK = 'present, not printed: nothing reads it after the release';

export const LEGACY_COLUMNS = [
  { table: 'projects', column: 'description', v1: 'nothing: a project carries no description' },
  { table: 'projects', column: 'kind', v1: 'source.type (website → storefront, standard → git)' },
  { table: 'projects', column: 'repo_url', v1: 'source.git.repository (host/owner/repo)' },
  { table: 'projects', column: 'workspace_setup', v1: 'workspace.setup' },
  { table: 'projects', column: 'base_branch', v1: 'source.git.defaultBranch' },
  {
    table: 'projects',
    column: 'webhook_secret',
    v1: "nothing: no route reads it; a provider's webhook is verified with its binding's secret",
    discard: true,
  },
  {
    table: 'projects',
    column: 'api_key',
    v1: 'nothing: no route authenticated a project API key',
    discard: true,
  },
  {
    table: 'projects',
    column: 'release_chain',
    v1: 'source.git.branches, promotions and the production environment deploysFrom',
  },
  {
    table: 'projects',
    column: 'environments',
    v1: 'environments.<name> (url, verification) and a testing profile per environment',
  },
  {
    table: 'projects',
    column: 'repo_path',
    v1: 'the device binding: forge-runner bind <slug> --path <dir>',
  },
  { table: 'projects', column: 'default_device_id', v1: 'nothing: no box is a default' },
  {
    table: 'projects',
    column: 'agent_config',
    v1: 'policy (pipelineConfig), PATCH /plugins (plugins), assistantWeekly; the rest is dropped',
  },
  {
    table: 'integration_bindings',
    column: 'stages',
    v1: 'environments.<name>.deployment.binding',
  },
];

const SECRET_KEY = /secret|token|password|passwd|credential|api[-_]?key|private[-_]?key|bearer/i;
const NAMES_ONLY = new Set(['env', 'headers']);

export function redact(value, key = '') {
  if (key === 'testCredentials' && Array.isArray(value)) {
    return value.map((c) => ({
      label: c && typeof c === 'object' && typeof c.label === 'string' ? c.label : null,
      credential: SECRET_MARK,
    }));
  }
  if (value === null || typeof value !== 'object') {
    return SECRET_KEY.test(key) && value !== null && value !== '' ? SECRET_MARK : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (NAMES_ONLY.has(key))
    return Object.fromEntries(Object.keys(value).map((k) => [k, SECRET_MARK]));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
}

export async function presentColumns(sql) {
  const tables = [...new Set(LEGACY_COLUMNS.map((c) => c.table))];
  const rows = await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name IN ${sql(tables)}
  `;
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

const rollbackOf = (b) =>
  b.binding_rollback != null
    ? { from: 'binding', value: b.binding_rollback }
    : b.connection_rollback != null
      ? { from: 'connection', value: b.connection_rollback }
      : null;

const held = (c, value) =>
  c.discard && value !== null && value !== '' ? DISCARDED_MARK : redact(value, c.column);

const ident = (s) => `"${s.replaceAll('"', '""')}"`;

export async function readLegacyConfig(sql) {
  const present = await presentColumns(sql);
  const columns = LEGACY_COLUMNS.map((c) => ({
    ...c,
    present: present.has(`${c.table}.${c.column}`),
  }));
  const projectCols = columns.filter((c) => c.table === 'projects' && c.present);
  const archived = present.has('projects.archived_at') ? 'archived_at' : 'NULL::timestamptz';
  const select = ['id', 'slug', 'name', `${archived} AS archived_at`]
    .concat(projectCols.map((c) => ident(c.column)))
    .join(', ');
  const projects = await sql.unsafe(`SELECT ${select} FROM projects ORDER BY slug`);

  const stages = present.has('integration_bindings.stages') ? 'b.stages' : 'NULL::text[]';
  const label = present.has('integration_bindings.label') ? 'b.label' : 'NULL::text';
  const bindings = await sql.unsafe(`
    SELECT b.project_id, b.id, b.provider, b.role, ${label} AS label, ${stages} AS stages,
           b.config -> 'rollback' AS binding_rollback, c.config -> 'rollback' AS connection_rollback
      FROM integration_bindings b
      JOIN integration_connections c ON c.id = b.connection_id
     ORDER BY b.project_id, b.provider, b.id
  `);

  return {
    columns: columns.map(({ table, column, present: p, v1 }) => ({
      table,
      column,
      present: p,
      v1,
    })),
    projects: projects.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      archived: p.archived_at !== null,
      legacy: Object.fromEntries(projectCols.map((c) => [c.column, held(c, p[c.column])])),
      bindings: bindings
        .filter((b) => b.project_id === p.id)
        .map((b) => ({
          id: b.id,
          provider: b.provider,
          role: b.role,
          label: b.label,
          stages: b.stages,
          rollback: rollbackOf(b),
        })),
    })),
  };
}

export async function withReadOnly(url, fn) {
  const postgres = loadPostgres();
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { default_transaction_read_only: 'on', application_name: LABEL },
  });
  try {
    return await sql.begin('isolation level repeatable read read only', async (tx) => fn(tx));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function loadPostgres() {
  const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
  return require('postgres');
}

function where(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return 'the given database';
  }
}

function show(value) {
  if (value === null || value === undefined) return ' null';
  if (typeof value === 'string')
    return value.includes('\n') ? `\n${indent(value, 6)}` : ` ${value}`;
  return `\n${indent(JSON.stringify(value, null, 2), 6)}`;
}

function indent(text, n) {
  return text
    .split('\n')
    .map((l) => `${' '.repeat(n)}${l}`)
    .join('\n');
}

export function render(report, url) {
  const out = [`${LABEL}: ${where(url)} (read-only)`, ''];
  for (const c of report.columns) {
    out.push(
      c.present
        ? `  present  ${c.table}.${c.column}  → re-enter as ${c.v1}`
        : `  absent   ${c.table}.${c.column}  (this database does not hold it; nothing to export)`,
    );
  }
  out.push('');
  const rollbacks = report.projects.some((p) => p.bindings.some((b) => b.rollback !== null));
  if (!report.columns.some((c) => c.present) && !rollbacks) {
    out.push(
      'No legacy column exists in this database and no binding declares a rollback, so there is no old config to export.',
    );
    return out.join('\n');
  }
  out.push(
    'Every binding is listed with its label and the free-text rollback it carries; re-enter that text by hand.',
  );
  out.push(`${report.projects.length} project(s)`);
  for (const p of report.projects) {
    out.push('', `project ${p.slug} (${p.id}) "${p.name}"${p.archived ? ' [archived]' : ''}`);
    for (const [column, value] of Object.entries(p.legacy)) {
      out.push(`  ${column}:${show(value)}`);
    }
    for (const b of p.bindings) {
      const stages = b.stages === null ? '' : ` stages=${JSON.stringify(b.stages)}`;
      out.push(
        `  binding ${b.id} ${b.provider} role=${b.role} label=${JSON.stringify(b.label)}${stages}`,
      );
      out.push(
        b.rollback === null
          ? '    rollback: none declared'
          : `    rollback (on the ${b.rollback.from}):${show(b.rollback.value)}`,
      );
    }
  }
  return out.join('\n');
}

async function main(argv) {
  const json = argv.includes('--json');
  const at = argv.indexOf('--url');
  const url = at >= 0 ? argv[at + 1] : process.env.DATABASE_URL;
  if (!url) {
    console.error(`${LABEL}: no database named — set DATABASE_URL or pass --url <postgres url>`);
    process.exit(2);
  }
  let report;
  try {
    report = await withReadOnly(url, readLegacyConfig);
  } catch (err) {
    console.error(`${LABEL}: could not read ${where(url)}: ${err.message}`);
    process.exit(2);
  }
  console.log(json ? JSON.stringify(report, null, 2) : render(report, url));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
