import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { baseRef, ciBranches } from '../../../../scripts/lib/base-branch.mjs';
import {
  JOURNAL_PATH,
  type JournalEntry,
  journal,
  MIGRATIONS_FOLDER,
  migrateDatabase,
  migrateThrough,
} from './migrations.js';
import { startPostgres, stopPostgres } from './postgres-container.js';

export const TEMPLATE_DB = 'forge_template';
const SEEDED_DB = 'forge_template_seeded';

/** The process environment every integration process reads the app's modules under. */
export const TEST_PROCESS_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JWT_SECRET: 'integration-secret-at-least-32-characters-long',
  DEVICE_TOKEN_PEPPER: 'integration-pepper-at-least-32-characters-long',
} as const;

/** Set to the reason, it runs this tree's new migrations over an empty template, said every run. */
const WAIVER_ENV = 'INTEGRATION_SEED_WAIVER';

let owned: string | null = null;

function removeOnExit(): void {
  if (owned === null) return;
  const name = owned;
  owned = null;
  try {
    stopPostgres(name);
  } catch {}
}

interface Split {
  /** `origin/dev (merge target dev, from GITHUB_BASE_REF)`: what the base was and how it was read. */
  base: string;
  /** The newest migration of this tree's journal that the base already carries. */
  landed: JournalEntry;
  /** This tree's migrations the base does not carry, in journal order. */
  fresh: JournalEntry[];
}

function git(args: string[], cwd: string): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** The tags `ref`'s journal carries, or null where it carries none git can read. */
function carriedBy(root: string, ref: string): Set<string> | null {
  const text = git(['show', `${ref}:${JOURNAL_PATH}`], root);
  if (text === null) return null;
  return new Set((JSON.parse(text) as { entries: JournalEntry[] }).entries.map((e) => e.tag));
}

/** How many of `ours`, from the first, `carried` holds before the first it does not. */
function sharedRun(ours: JournalEntry[], carried: Set<string>): number {
  const first = ours.findIndex((e) => !carried.has(e.tag));
  return first < 0 ? ours.length : first;
}

interface Target {
  ref: string;
  where: string;
  carried: Set<string>;
}

/**
 * The merge target as every delta-scoped gate reads it (`scripts/lib/base-branch.mjs`). A local run
 * that reaches only `origin/HEAD` measures against whichever branch CI gates shares the longest run
 * of this tree's journal, said in the log: in a checkout cut from `dev`, `origin/HEAD` names `main`,
 * whose older schema the factories cannot seed.
 */
function mergeTarget(root: string, ours: JournalEntry[]): Target {
  const base = baseRef(root);
  if (base.refusal !== undefined) {
    throw new Error(
      'the integration template proves every migration this tree adds against a database that ' +
        `holds rows, and needs the merge target to know which those are: ${base.refusal}\n` +
        `${WAIVER_ENV}=<why> runs them over an empty database instead, said on every run.`,
    );
  }
  const named = carriedBy(root, base.ref);
  if (named === null) {
    throw new Error(
      `${base.ref} (merge target ${base.branch}, from ${base.source}) carries no readable ` +
        `${JOURNAL_PATH}, so no migration of this tree is known to have landed.`,
    );
  }
  const target: Target = {
    ref: base.ref,
    where: `${base.ref} (merge target ${base.branch}, from ${base.source})`,
    carried: named,
  };
  if (base.source !== 'origin/HEAD') return target;
  const ci = git(['show', 'HEAD:.github/workflows/ci.yml'], root);
  let best = target;
  for (const branch of ci === null ? [] : (ciBranches(ci).push ?? [])) {
    const ref = `origin/${branch}`;
    const carried = ref === base.ref ? null : carriedBy(root, ref);
    if (carried === null || sharedRun(ours, carried) <= sharedRun(ours, best.carried)) continue;
    best = {
      ref,
      where:
        `${ref} (the gated branch sharing most of this journal; origin/HEAD names ` +
        `${base.branch}, and GITHUB_BASE_REF=<branch> names another)`,
      carried,
    };
  }
  return best;
}

/** This tree's journal cut where its merge target's ends. */
function splitAtBase(): Split {
  const root = git(['rev-parse', '--show-toplevel'], MIGRATIONS_FOLDER)?.trim();
  if (!root) {
    throw new Error(
      `the integration template could not find the git checkout holding ${MIGRATIONS_FOLDER}, so ` +
        'which migrations this tree adds to its merge target cannot be read.',
    );
  }
  const ours = journal().entries;
  const target = mergeTarget(root, ours);
  const first = sharedRun(ours, target.carried);
  if (first === ours.length) {
    return { base: target.where, landed: ours[first - 1] as JournalEntry, fresh: [] };
  }
  const landed = ours[first - 1];
  if (landed === undefined) {
    throw new Error(
      `${target.where} carries none of this tree's first migration ${ours[0]?.tag}, so the two ` +
        'journals share no schema to seed before the new migrations run.',
    );
  }
  return { base: target.where, landed, fresh: ours.slice(first) };
}

/** The Postgres error under a drizzle or factory failure: its SQLSTATE and its message. */
function pgFault(err: unknown): string {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `${code} (${e.message})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Runs the seed in this process, with the environment the app's modules read set and then restored. */
async function seedAt(url: string, split: Split): Promise<Record<string, number>> {
  const keys = ['DATABASE_URL', ...Object.keys(TEST_PROCESS_ENV)];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(TEST_PROCESS_ENV)) process.env[k] ??= v;
  process.env.NODE_ENV = TEST_PROCESS_ENV.NODE_ENV;
  process.env.DATABASE_URL = url;
  try {
    const { SeedRefused, seedFactoryWorld } = await import('./template-seed.js');
    try {
      return await seedFactoryWorld();
    } catch (err) {
      if (!(err instanceof SeedRefused)) throw err;
      throw new Error(
        `the integration factories could not seed the schema ${split.base} carries, through ` +
          `${split.landed.tag}: ${err.step} was refused with ${pgFault(err.cause)}.\n` +
          "This tree's new migrations are proved against that database once it holds the rows " +
          'tests/helpers/factories.ts writes, so a factory naming a column or table the base ' +
          'schema lacks means this tree changes the shape the factories write. Make the factory ' +
          'write a shape both schemas hold; where the branch renames what a factory writes, ' +
          `${WAIVER_ENV}=<why> runs the new migrations over an empty database, said on every run.`,
      );
    }
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** This tree's new migrations, one at a time, over the seeded rows: refused at the first that fails. */
async function migrateOverRows(
  url: string,
  split: Split,
  held: Record<string, number>,
): Promise<void> {
  for (const entry of split.fresh) {
    try {
      await migrateThrough(url, entry.tag);
    } catch (err) {
      const tables = Object.entries(held)
        .map(([t, n]) => `${t} ${n}`)
        .join(', ');
      throw new Error(
        `migration ${entry.tag} cannot be applied to a database that holds rows: Postgres refused ` +
          `it with ${pgFault(err)}.\n` +
          `The template was migrated through ${split.landed.tag}, the newest migration ` +
          `${split.base} carries, seeded by tests/helpers/factories.ts (${tables}), and given ` +
          `this tree's ${split.fresh.length} new migration(s) one at a time; ${entry.tag} is the ` +
          'first refused. An empty database accepts it, which is why no test sees it; a deployed ' +
          'database holding such a row refuses it the same way, and the deploy does not start.',
      );
    }
  }
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [recorded] = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations
    `;
    const expected = journal().entries.length;
    if (recorded?.n !== expected) {
      throw new Error(
        `the seeded template recorded ${recorded?.n} migrations where the journal holds ` +
          `${expected}: drizzle skipped one of ${split.fresh.map((e) => e.tag).join(', ')}.`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function asAdmin(adminUrl: string, statement: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function urlOf(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Migrates the template every test file clones. Where this tree adds migrations to its merge
 * target, a copy taken at the target's newest migration is seeded and given the new ones over its
 * rows first; the template itself stays empty, as every test file expects it.
 */
async function buildTemplate(adminUrl: string): Promise<string> {
  const template = urlOf(adminUrl, TEMPLATE_DB);
  const waiver = process.env[WAIVER_ENV]?.trim();
  if (waiver) {
    await migrateDatabase(template);
    return `new migrations NOT proved over rows: ${WAIVER_ENV} waives it (${waiver})`;
  }
  const split = splitAtBase();
  if (split.fresh.length === 0) {
    await migrateDatabase(template);
    return `no migration new to ${split.base}`;
  }
  await migrateThrough(template, split.landed.tag);
  await asAdmin(adminUrl, `CREATE DATABASE "${SEEDED_DB}" TEMPLATE "${TEMPLATE_DB}"`);
  const seeded = urlOf(adminUrl, SEEDED_DB);
  try {
    const held = await seedAt(seeded, split);
    await Promise.all([migrateDatabase(template), migrateOverRows(seeded, split, held)]);
    return (
      `${split.fresh.length} migration(s) new to ${split.base} applied over rows in ` +
      `${Object.keys(held).length} tables: ${split.fresh.map((e) => e.tag).join(', ')}`
    );
  } finally {
    await asAdmin(adminUrl, `DROP DATABASE IF EXISTS "${SEEDED_DB}" WITH (FORCE)`);
  }
}

export async function setup(): Promise<void> {
  const started = await startPostgres();
  owned = started.name;
  process.once('exit', removeOnExit);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      removeOnExit();
      process.exit(130);
    });
  }
  await asAdmin(started.adminUrl, `CREATE DATABASE "${TEMPLATE_DB}"`);
  const began = Date.now();
  const proved = await buildTemplate(started.adminUrl);
  console.log(
    `[integration] ${started.name} on 127.0.0.1:${started.port}, template migrated in ${Date.now() - began}ms; ${proved}`,
  );
  process.env.TEST_PG_ADMIN_URL = started.adminUrl;
  process.env.TEST_PG_TEMPLATE = TEMPLATE_DB;
}

export async function teardown(): Promise<void> {
  if (owned === null) return;
  const name = owned;
  owned = null;
  stopPostgres(name);
}
