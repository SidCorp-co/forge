/**
 * What a release's own commit range ships, read from the repository (REQ-40 BC-7, BC-9): the range
 * is the previous shipped release's served commit up to the commit this one deploys. Read from
 * there, an admin's migration, a new required setting, a changed API operation and a moved
 * dependency are named whether or not any issue filled in a field about them.
 *
 * - migrations: entries the drizzle journal gains in the range;
 * - API contracts: operations of the generated OpenAPI file added, removed or changed, a schema an
 *   operation reaches counting as part of it;
 * - dependencies: moves in every `package.json` the range changes;
 * - settings: environment names a deployment file (`docker-compose*.yml`) names that its base did
 *   not, required where it is written `${NAME:?...}`.
 *
 * A range that cannot be read whole is `unread` with why, never an empty answer.
 */

import { posix } from 'node:path';
import type { ReleaseShipped } from '@forge/contracts/release-page';
import {
  type HostFileChange,
  resolveSourceHost,
  type SourceHost,
} from '../integrations/source-host/index.js';
import { shippedReleaseRuns } from './shipped-earlier.js';

/** The two reads a range needs; a `SourceHost` is one. */
export type RangeHost = Pick<SourceHost, 'compareFiles' | 'readFile'>;

const JOURNAL = /(^|\/)drizzle\/migrations\/meta\/_journal\.json$/;
const OPENAPI = /(^|\/)contracts\/[^/]+\.openapi\.json$/;
const MANIFEST = /(^|\/)package\.json$/;
const COMPOSE = /(^|\/)docker-compose[^/]*\.ya?ml$/;

/** The largest file the range reads at either end: the generated API contract is over a megabyte. */
const FILE_MAX_BYTES = 8 * 1024 * 1024;

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

type Text = string | null;

/** A file's text at `ref`, or null where the file does not exist there (it was added or removed). */
async function textAt(host: RangeHost, path: string, ref: string): Promise<Text> {
  const read = await host.readFile(path, ref, FILE_MAX_BYTES);
  return typeof read === 'string' ? read : null;
}

function jsonOf(text: Text, path: string, ref: string): Record<string, unknown> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // named below
  }
  throw new Error(`${path} at ${ref} is not a JSON object`);
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => a.localeCompare(b, 'en'));

async function journalTags(host: RangeHost, path: string, ref: string): Promise<Set<string>> {
  const doc = jsonOf(await textAt(host, path, ref), path, ref);
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  return new Set(
    entries.flatMap((e) =>
      typeof (e as { tag?: unknown })?.tag === 'string' ? [(e as { tag: string }).tag] : [],
    ),
  );
}

/** Migration files the journal gains: `<dir>/<tag>.sql`, where `<dir>` is the folder holding `meta/`. */
async function migrationsOf(
  host: RangeHost,
  journals: readonly string[],
  base: string,
  head: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const path of journals) {
    const [before, after] = await Promise.all([
      journalTags(host, path, base),
      journalTags(host, path, head),
    ]);
    const dir = posix.dirname(posix.dirname(path));
    for (const tag of after) if (!before.has(tag)) out.push(posix.join(dir, `${tag}.sql`));
  }
  return sorted(out);
}

type Operations = Map<string, string>;

const refsIn = (node: unknown, into: Set<string>): void => {
  if (Array.isArray(node)) for (const n of node) refsIn(n, into);
  else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') into.add(v);
      else refsIn(v, into);
    }
  }
};

/** Each operation as `METHOD /path`, its text, and the names of the schemas it reaches. */
function operationsOf(doc: Record<string, unknown>) {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  const schemas = ((doc.components as { schemas?: Record<string, unknown> } | undefined)?.schemas ??
    {}) as Record<string, unknown>;
  const ops: Operations = new Map();
  const reach = new Map<string, Set<string>>();
  const prefix = '#/components/schemas/';
  const closure = (op: unknown): Set<string> => {
    const seen = new Set<string>();
    const queue = new Set<string>();
    refsIn(op, queue);
    for (const ref of queue) {
      const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      const inner = new Set<string>();
      refsIn(schemas[name], inner);
      for (const r of inner) queue.add(r);
    }
    return seen;
  };
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (op === undefined) continue;
      const id = `${method.toUpperCase()} ${path}`;
      ops.set(id, JSON.stringify(op));
      reach.set(id, closure(op));
    }
  }
  return { ops, reach, schemas };
}

async function contractsOf(
  host: RangeHost,
  paths: readonly string[],
  base: string,
  head: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const [before, after] = await Promise.all([textAt(host, path, base), textAt(host, path, head)]);
    const was = operationsOf(jsonOf(before, path, base));
    const now = operationsOf(jsonOf(after, path, head));
    const schemaMoved = (name: string) =>
      JSON.stringify(was.schemas[name]) !== JSON.stringify(now.schemas[name]);
    for (const [id, text] of now.ops) {
      const prior = was.ops.get(id);
      if (prior === undefined) out.push(`added ${id}`);
      else if (prior !== text || [...(now.reach.get(id) ?? [])].some(schemaMoved))
        out.push(`changed ${id}`);
    }
    for (const id of was.ops.keys()) if (!now.ops.has(id)) out.push(`removed ${id}`);
  }
  return sorted(out);
}

function dependenciesIn(text: Text, path: string, ref: string): Map<string, string> {
  const doc = jsonOf(text, path, ref);
  const out = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const group = doc[field];
    if (typeof group !== 'object' || group === null) continue;
    for (const [name, range] of Object.entries(group)) {
      if (typeof range === 'string') out.set(name, range);
    }
  }
  return out;
}

async function dependenciesOf(
  host: RangeHost,
  paths: readonly string[],
  base: string,
  head: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const [before, after] = await Promise.all([textAt(host, path, base), textAt(host, path, head)]);
    const was = dependenciesIn(before, path, base);
    const now = dependenciesIn(after, path, head);
    const where = posix.dirname(path);
    for (const [name, range] of now) {
      const prior = was.get(name);
      if (prior === undefined) out.push(`${where}: added ${name} ${range}`);
      else if (prior !== range) out.push(`${where}: ${name} ${prior} -> ${range}`);
    }
    for (const name of was.keys()) if (!now.has(name)) out.push(`${where}: removed ${name}`);
  }
  return sorted(out);
}

const ENV_LINE = /^\s*(?:-\s*)?([A-Z][A-Z0-9_]*)\s*[:=]\s*(.*)$/;

/** The environment names a deployment file sets, each whether the file refuses to start without it. */
function settingsIn(text: Text): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of (text ?? '').split('\n')) {
    const m = ENV_LINE.exec(line);
    if (!m) continue;
    const name = m[1] as string;
    const required = new RegExp(`\\$\\{${name}:\\?`).test(m[2] ?? '');
    out.set(name, (out.get(name) ?? false) || required);
  }
  return out;
}

async function settingsOf(
  host: RangeHost,
  paths: readonly string[],
  base: string,
  head: string,
): Promise<{ name: string; required: boolean }[]> {
  const known = new Set<string>();
  const added = new Map<string, boolean>();
  for (const path of paths) {
    const [before, after] = await Promise.all([textAt(host, path, base), textAt(host, path, head)]);
    for (const name of settingsIn(before).keys()) known.add(name);
    for (const [name, required] of settingsIn(after)) {
      added.set(name, (added.get(name) ?? false) || required);
    }
  }
  return sorted([...added.keys()].filter((n) => !known.has(n))).map((name) => ({
    name,
    required: added.get(name) === true,
  }));
}

const alive = (changes: readonly HostFileChange[], pattern: RegExp) =>
  sorted(changes.filter((c) => pattern.test(c.path)).map((c) => c.path));

/** What the range `base..head` ships, read through `host`. */
export async function shippedBetween(
  host: RangeHost,
  base: string,
  head: string,
): Promise<ReleaseShipped> {
  const compared = await host.compareFiles(base, head);
  if ('why' in compared) {
    return {
      state: 'unread',
      why: `the files ${base.slice(0, 7)}..${head.slice(0, 7)} changed could not be named: ${compared.why}`,
    };
  }
  const changed = compared.changes;
  try {
    const [migrations, contracts, dependencies, settings] = await Promise.all([
      migrationsOf(host, alive(changed, JOURNAL), base, head),
      contractsOf(host, alive(changed, OPENAPI), base, head),
      dependenciesOf(host, alive(changed, MANIFEST), base, head),
      settingsOf(host, alive(changed, COMPOSE), base, head),
    ]);
    return { state: 'read', base, head, migrations, contracts, dependencies, settings };
  } catch (err) {
    return {
      state: 'unread',
      why: `what ${base.slice(0, 7)}..${head.slice(0, 7)} ships could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// A range between two commits never changes, so a successful reading is kept for the process,
// bounded, oldest out first; an unread one is a reading about the moment and is never kept.
const KEPT = new Map<string, ReleaseShipped>();
const KEPT_LIMIT = 200;

/**
 * What the release `version`, deploying `head`, ships over the release shipped before it (or, for a
 * release not yet shipped, over the newest one shipped): `unread` with why where there is no cut
 * build, no earlier release to compare with, or no repository to read.
 */
export async function readShipped(
  projectId: string,
  version: string,
  head: string | null,
  host?: (projectId: string) => Promise<RangeHost>,
): Promise<ReleaseShipped> {
  if (head === null) {
    return { state: 'unread', why: 'the release has no cut build to read a range up to' };
  }
  const runs = await shippedReleaseRuns(projectId);
  const at = runs.findIndex((r) => r.version === version);
  const prior = at === -1 ? runs[runs.length - 1] : runs[at - 1];
  if (!prior) {
    return {
      state: 'unread',
      why: 'no release shipped before this one, so there is no range to read',
    };
  }
  let source: RangeHost;
  try {
    source = await (host ?? ((id) => resolveSourceHost(id, 'kernel')))(projectId);
  } catch (err) {
    return {
      state: 'unread',
      why: `the project's repository could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const key = `${projectId}\u0000${prior.commit}\u0000${head}`;
  const kept = KEPT.get(key);
  if (kept) return kept;
  const read = await shippedBetween(source, prior.commit, head);
  if (read.state === 'read') {
    if (KEPT.size >= KEPT_LIMIT) KEPT.delete(KEPT.keys().next().value as string);
    KEPT.set(key, read);
  }
  return read;
}
