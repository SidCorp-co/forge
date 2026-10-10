/**
 * What a release's own commit range ships (REQ-40 BC-7, BC-9): the range is the previous shipped
 * release's served commit up to the commit this one deploys. Read from there, an admin's migration,
 * a new required setting, a changed API operation and a moved dependency are named whether or not any
 * issue filled in a field about them.
 *
 * - migrations: entries the drizzle journal gains in the range;
 * - API contracts: operations of the generated OpenAPI file added, removed or changed, a schema an
 *   operation reaches counting as part of it;
 * - dependencies: moves in every `package.json` the range changes;
 * - settings: environment names a deployment file (`docker-compose*.yml`) names that its base did
 *   not, required where it is written `${NAME:?...}`.
 *
 * The run that cut the release has the range in its checkout, so it reports it (`forge-runner
 * release range`): which files changed, then the two ends of each file this reader reads
 * (`rangeReads`). The reading is kept on the release run (`metadata.range`) with the changed files
 * themselves, which the developer view sorts into what the release changes, and the page reads it
 * from there; no source host is called, so a project with no repository binding reads the same way
 * as one with one. A range not reported is `unread` with why, never an empty answer.
 */

import { posix } from 'node:path';
import type {
  ReleaseRangeBase,
  ReleaseRangeReport,
  ReleaseShipped,
} from '@forge/contracts/release-page';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { writeRunMetadata } from '../pipeline/index.js';
import { refuseRelease } from './refuse.js';
import { shippedReleaseRuns } from './shipped-earlier.js';

/** One file a range changed; a rename is its old path removed and its new one added. */
export interface RangeChange {
  readonly path: string;
  readonly change: 'added' | 'changed' | 'removed';
}

/** The two reads the reader takes of a range: which files changed, and a file's text at one end. */
export interface RangeHost {
  compareFiles(
    base: string,
    head: string,
  ): Promise<{ readonly changes: readonly RangeChange[] } | { readonly why: string }>;
  readFile(path: string, ref: string, maxBytes: number): Promise<string | { missing: string }>;
}

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

const alive = (changes: readonly RangeChange[], pattern: RegExp) =>
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

const READ = [JOURNAL, OPENAPI, MANIFEST, COMPOSE];

/** The changed files this reader reads at both ends: the run sends these, and only these. */
export function rangeReads(changes: readonly RangeChange[]): string[] {
  return sorted(changes.filter((c) => READ.some((p) => p.test(c.path))).map((c) => c.path));
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Where the range of the release `version` starts: the commit the release shipped before it served
 * (for a release not yet shipped, the newest one shipped), or why there is none.
 */
export async function rangeBaseOf(
  projectId: string,
  version: string | null,
): Promise<ReleaseRangeBase> {
  const runs = await shippedReleaseRuns(projectId);
  const at = version === null ? -1 : runs.findIndex((r) => r.version === version);
  const prior = at === -1 ? runs[runs.length - 1] : runs[at - 1];
  return prior
    ? { base: prior.commit, why: null }
    : { base: null, why: 'no release shipped before this one, so there is no range to read' };
}

/** A report read as a repository: its changes, and each file it sent at the end it was asked for. */
function reportedHost(report: ReleaseRangeReport): RangeHost {
  const files = new Map(report.files.map((f) => [f.path, f]));
  return {
    compareFiles: async () => ({ changes: report.changes }),
    readFile: async (path, ref) => {
      const end = ref === report.base ? 'base' : ref === report.head ? 'head' : null;
      const text = end === null ? null : (files.get(path)?.[end] ?? null);
      return text ?? { missing: `${path} does not exist at ${short(ref)}` };
    },
  };
}

const KEY = 'range';

/**
 * Keep what the release run reports its range ships (BC-7, BC-9), read by `shippedBetween`. Refused
 * by name, with nothing kept: a release with no release before it, a base that is not the commit that
 * release served, a file the reader reads that was not sent, and one it does not read.
 */
export async function recordRange(args: {
  projectId: string;
  runId: string;
  version: string | null;
  report: ReleaseRangeReport;
}): Promise<ReleaseShipped> {
  const { report } = args;
  const start = await rangeBaseOf(args.projectId, args.version);
  if (start.base === null) throw refuseRelease('RELEASE_RANGE_NO_BASE', start.why, '/base');
  if (report.base !== start.base) {
    throw refuseRelease(
      'RELEASE_RANGE_BASE_MOVED',
      `the range starts at ${short(start.base)}, the commit the release before this one served, not at ${short(report.base)}: read it again with \`GET release-batches/${args.runId}/range\``,
      '/base',
    );
  }
  const reads = new Set(rangeReads(report.changes));
  const sent = new Set(report.files.map((f) => f.path));
  const missing = [...reads].filter((p) => !sent.has(p));
  if (missing.length > 0) {
    throw refuseRelease(
      'RELEASE_RANGE_FILE_MISSING',
      `the range changes ${missing.join(', ')}, which the reader reads, and the report does not send ${missing.length === 1 ? 'it' : 'them'}: send each with its text at base and at head (null where it does not exist there)`,
      '/files',
    );
  }
  const unread = [...sent].filter((p) => !reads.has(p));
  if (unread.length > 0) {
    throw refuseRelease(
      'RELEASE_RANGE_FILE_UNREAD',
      `${unread.join(', ')} ${unread.length === 1 ? 'is' : 'are'} not a file the reader reads of this range: send only the paths \`POST release-batches/${args.runId}/range/reads\` answers`,
      '/files',
    );
  }
  const read = await shippedBetween(reportedHost(report), report.base, report.head);
  const changed = read.state === 'read' ? { changed: report.changes } : {};
  await writeRunMetadata(args.runId, {
    merge: { [KEY]: { ...read, ...changed, reportedAt: new Date().toISOString() } },
    touch: true,
  });
  return read;
}

const CHANGES: ReadonlySet<string> = new Set(['added', 'changed', 'removed']);

/**
 * The files a kept reading says its range changed, or null where it was kept before the files were
 * (or holds one that is not a changed file, which says the same: the list cannot be trusted whole).
 */
function changedOf(value: unknown): RangeChange[] | null {
  const raw = (value as { changed?: unknown } | null)?.changed;
  if (!Array.isArray(raw)) return null;
  const out: RangeChange[] = [];
  for (const c of raw) {
    const path = (c as { path?: unknown })?.path;
    const change = (c as { change?: unknown })?.change;
    if (typeof path !== 'string' || typeof change !== 'string' || !CHANGES.has(change)) return null;
    out.push({ path, change: change as RangeChange['change'] });
  }
  return out;
}

function storedOf(value: unknown): ReleaseShipped | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.state === 'unread' && typeof v.why === 'string') return { state: 'unread', why: v.why };
  if (v.state !== 'read' || typeof v.base !== 'string' || typeof v.head !== 'string') return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((i) => typeof i === 'string') : []);
  return {
    state: 'read',
    base: v.base,
    head: v.head,
    migrations: list(v.migrations),
    contracts: list(v.contracts),
    dependencies: list(v.dependencies),
    settings: (Array.isArray(v.settings) ? v.settings : []).flatMap((x) =>
      typeof x?.name === 'string'
        ? [{ name: x.name as string, required: x.required === true }]
        : [],
    ),
  };
}

/** What a range ships, and the files it changed: null where the range is unread or was kept without them. */
export interface RangeReading {
  shipped: ReleaseShipped;
  changed: RangeChange[] | null;
}

/**
 * What the release `version`, deploying `head`, ships, as its run reported it, with the files the
 * range changed where the reading kept them: `unread` with why where there is no cut build, no earlier
 * release to compare with, no report, or a report of a range other than the one from the release
 * before it to `head`.
 */
export async function readRange(
  projectId: string,
  version: string,
  head: string | null,
  runId: string | null,
): Promise<RangeReading> {
  const unread = (why: string): RangeReading => ({ shipped: { state: 'unread', why }, changed: null });
  if (head === null) return unread('the release has no cut build to read a range up to');
  const start = await rangeBaseOf(projectId, version);
  if (start.base === null) return unread(start.why);
  const [row] = runId
    ? await db
        .select({ range: sql<unknown>`${pipelineRuns.metadata} -> ${KEY}` })
        .from(pipelineRuns)
        .where(eq(pipelineRuns.id, runId))
    : [];
  const stored = storedOf(row?.range);
  const range = `${short(start.base)}..${short(head)}`;
  if (!stored) {
    return unread(
      `the release run did not report what its range ${range} ships: the run that cuts a release reports it with \`forge-runner release range\` from its checkout, before \`finish\``,
    );
  }
  if (stored.state === 'unread') return { shipped: stored, changed: null };
  if (stored.head !== head || stored.base !== start.base) {
    return unread(
      `the release run reported the range ${short(stored.base)}..${short(stored.head)}, not ${range}, the range from the release before this one to the build this page describes`,
    );
  }
  return { shipped: stored, changed: changedOf(row?.range) };
}
