import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import postgres, { type Sql } from 'postgres';

export const TEMPLATE_PREFIX = 'forge_test_tpl_';

const CONTENT_LENGTH = 24;

/** A template named for the content it was built from, as opposed to one stamped for a single run. */
export const SHARED_TEMPLATE = new RegExp(`^${TEMPLATE_PREFIX}[0-9a-f]{${CONTENT_LENGTH}}$`);

/** How long a shared template may go untouched by every run before the reaper may drop it. */
export const IDLE_REAP_AFTER_MS = 24 * 60 * 60 * 1000;

/** Longest a run waits for another run's build of the same template. */
const BUILD_WAIT = '15min';

const MARKER = /^forge-template v1 content=([0-9a-f]+) built=(\d+) used=(\d+)$/;

export type TemplateMode = 'shared' | 'fresh';

export function stamp(): string {
  return `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/** Everything `drizzle/migrations/` holds, in a fixed order, so the name moves when any byte does. */
export function hashMigrations(folder: string): string {
  if (!existsSync(folder)) {
    throw new Error(
      `shared-template: ${folder} does not exist, so there is no migration content to name a ` +
        'template after. Run with TEST_TEMPLATE_MODE=fresh to build a private one.',
    );
  }
  const files = readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(folder, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
  if (files.length === 0) {
    throw new Error(`shared-template: ${folder} holds no files, so there is nothing to hash.`);
  }
  const hash = createHash('sha256');
  for (const rel of files) {
    const body = readFileSync(join(folder, rel));
    hash.update(`${rel}\0${body.length}\0`).update(body);
  }
  return hash.digest('hex').slice(0, CONTENT_LENGTH);
}

export function sharedTemplateName(content: string): string {
  return `${TEMPLATE_PREFIX}${content}`;
}

export interface Marker {
  content: string;
  built: number;
  used: number;
}

export function formatMarker(m: Marker): string {
  return `forge-template v1 content=${m.content} built=${m.built} used=${m.used}`;
}

export function parseMarker(text: string | null): Marker | null {
  const m = text === null ? null : MARKER.exec(text);
  if (!m) return null;
  return { content: m[1] as string, built: Number(m[2]), used: Number(m[3]) };
}

type Env = Readonly<Record<string, string | undefined>>;

function onCi(env: Env): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0';
}

/** Whether this run shares a template on its instance or builds a private one, and why. */
export function resolveTemplateMode(
  env: Env,
  hasInstance: boolean,
): { mode: TemplateMode; rule: string } {
  const raw = env.TEST_TEMPLATE_MODE;
  if (raw !== undefined && raw !== '' && raw !== 'shared' && raw !== 'fresh') {
    throw new Error(
      `TEST_TEMPLATE_MODE="${raw}" is not a template mode. It takes "shared" (one template per ` +
        'migration content on the instance) or "fresh" (a private one this run drops), or is ' +
        'left unset so the machine decides.',
    );
  }
  if (raw === 'shared' && !hasInstance) {
    throw new Error(
      'TEST_TEMPLATE_MODE=shared needs an instance that outlives the run, and TEST_DATABASE_URL ' +
        'is unset, so this run would start a container of its own and share with nothing.',
    );
  }
  if (raw === 'shared' || raw === 'fresh') return { mode: raw, rule: `TEST_TEMPLATE_MODE=${raw}` };
  if (!hasInstance) return { mode: 'fresh', rule: 'no TEST_DATABASE_URL, a container of its own' };
  if (onCi(env)) return { mode: 'fresh', rule: 'CI is set' };
  return { mode: 'shared', rule: 'TEST_DATABASE_URL is set and CI is not' };
}

function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

const buildKey = (name: string) => `build:${name}`;
const useKey = (name: string) => `use:${name}`;

async function markerOf(
  sql: Sql,
  name: string,
): Promise<{ present: boolean; text: string | null }> {
  const rows = await sql<{ marker: string | null }[]>`
    SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${name}
  `;
  return { present: rows.length > 0, text: rows[0]?.marker ?? null };
}

async function writeMarker(sql: Sql, name: string, marker: Marker): Promise<void> {
  await sql.unsafe(`COMMENT ON DATABASE "${name}" IS '${formatMarker(marker)}'`);
}

async function backendPid(sql: Sql): Promise<number> {
  const [row] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return (row as { pid: number }).pid;
}

/**
 * The connection that holds a run's use lock. `max_lifetime: 0` because postgres.js otherwise
 * recycles a connection after 30 to 60 minutes, and a recycled connection holds nothing.
 */
export const HOLDER_OPTIONS = {
  max: 1,
  max_lifetime: 0,
  idle_timeout: 0,
  onnotice: () => {},
} as const;

export interface SharedTemplate {
  name: string;
  /** True when this run built the template, false when it found it complete and took it as it was. */
  built: boolean;
  /** Stamp the template used and let go of it. A template this run did not build is never dropped here. */
  release: () => Promise<void>;
}

export interface AcquireOptions {
  adminUrl: string;
  migrationsFolder: string;
  /** Replay the migrations into the database at `url`. */
  migrate: (url: string) => Promise<void>;
  now?: () => number;
}

/**
 * The template for this migration content, built if no run has, and held for as long as the
 * returned handle lives.
 *
 * A build lock serialises the existence check and the build, so two runs entering together build
 * once. The build happens under a staging name and is renamed into place after its marker is
 * written, so the final name never exists half-built. A shared advisory lock on a connection of
 * its own is what tells the reaper the template is in use; it needs no clock, and a crashed run's
 * connection drops it.
 */
export async function acquireSharedTemplate(opts: AcquireOptions): Promise<SharedTemplate> {
  const now = opts.now ?? Date.now;
  const content = hashMigrations(opts.migrationsFolder);
  const name = sharedTemplateName(content);
  const holder = postgres(opts.adminUrl, HOLDER_OPTIONS);
  let built = false;
  let pid: number;
  try {
    pid = await backendPid(holder);
    await holder`SELECT set_config('lock_timeout', ${BUILD_WAIT}, false)`;
    await holder`SELECT pg_advisory_lock(hashtextextended(${buildKey(name)}, 0))`;
    try {
      const found = await markerOf(holder, name);
      if (!found.present) {
        await buildInto(holder, opts, name, content, now());
        built = true;
      } else {
        const marker = parseMarker(found.text);
        if (marker?.content !== content) {
          throw new Error(
            `shared template "${name}" exists on this instance and carries no completeness marker ` +
              `for its own content (its comment reads ${JSON.stringify(found.text)}). Something ` +
              'other than this suite made it, or a build was cut short in a way the staging ' +
              'rename should have made impossible. It is not rebuilt and not dropped here, since ' +
              'either would hide it; drop it by hand if it is yours to drop.',
          );
        }
      }
      await holder`SELECT pg_advisory_lock_shared(hashtextextended(${useKey(name)}, 0))`;
      await touch(holder, name, content, now());
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtextextended(${buildKey(name)}, 0))`;
    }
    await holder`RESET lock_timeout`;
  } catch (err) {
    await holder.end({ timeout: 5 }).catch(() => {});
    throw err;
  }

  return {
    name,
    built,
    release: async () => {
      try {
        const lost = await backendPid(holder).then(
          (current) => current !== pid,
          () => true,
        );
        if (lost) {
          console.error(
            `[shared-template] ${name}: the connection holding this run's use lock was replaced ` +
              `during the run (backend pid ${pid} is gone). For the time between, a reaper could ` +
              'have taken the template, so a clone failing with "does not exist" is that and not ' +
              'the code under test.',
          );
        } else {
          await touch(holder, name, content, now());
        }
      } finally {
        await holder.end({ timeout: 5 }).catch(() => {});
      }
    },
  };
}

async function touch(sql: Sql, name: string, content: string, used: number): Promise<void> {
  const current = parseMarker((await markerOf(sql, name)).text);
  await writeMarker(sql, name, { content, built: current?.built ?? used, used });
}

async function buildInto(
  admin: Sql,
  opts: AcquireOptions,
  name: string,
  content: string,
  builtAt: number,
): Promise<void> {
  const staging = `${TEMPLATE_PREFIX}stg_${stamp()}`;
  await admin.unsafe(`CREATE DATABASE "${staging}"`);
  try {
    await opts.migrate(databaseUrl(opts.adminUrl, staging));
    await writeMarker(admin, staging, { content, built: builtAt, used: builtAt });
    await admin.unsafe(`ALTER DATABASE "${staging}" RENAME TO "${name}"`);
  } catch (err) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${staging}" WITH (FORCE)`).catch(() => {});
    throw err;
  }
}

/**
 * Drop the shared template `name` if no run holds it and none has touched it for
 * `IDLE_REAP_AFTER_MS`. Both locks are tried, never waited on: a template somebody is building or
 * using is left alone rather than queued behind.
 */
export async function reapSharedTemplate(
  admin: Sql,
  name: string,
  now: number = Date.now(),
): Promise<boolean> {
  const conn = await admin.reserve();
  try {
    const [gate] = await conn<{ ok: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended(${buildKey(name)}, 0)) AS ok`;
    if (!gate?.ok) return false;
    try {
      const marker = parseMarker((await markerOf(conn, name)).text);
      if (marker === null || now - marker.used <= IDLE_REAP_AFTER_MS) return false;
      const [inUse] = await conn<{ ok: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${useKey(name)}, 0)) AS ok`;
      if (!inUse?.ok) return false;
      try {
        await conn.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
        return true;
      } catch {
        return false;
      } finally {
        await conn`SELECT pg_advisory_unlock(hashtextextended(${useKey(name)}, 0))`;
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtextextended(${buildKey(name)}, 0))`;
    }
  } finally {
    conn.release();
  }
}
