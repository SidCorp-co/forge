/**
 * Whether a served commit carries a judged one, and which paths a landing changed, read from the
 * project's own repository (ISS-1368). A served commit that equals the judged one is decided
 * without asking anything; every other pair is one compare, or two where the served commit does
 * not descend from the judged one and the files their trees differ in have to be named.
 *
 * A successful answer about two named commits, or one commit's own diff, is content-addressed and
 * never changes, so it is kept for the process, bounded, oldest out first; a failure is a reading
 * about the moment and is never kept. GitHub answers a pair with no common ancestor with a 404,
 * which arrives here as a failed request and is unread like any other.
 */

import type { GitHubRepoClient } from '../integrations/github/client.js';

/** GitHub names at most this many files in one compare, and says nothing of the rest. */
export const COMPARE_FILE_CEILING = 300;

const CACHE_LIMIT = 2000;

const TOO_MANY = `${COMPARE_FILE_CEILING} or more files differ, and the repository names no more than that in one compare`;

/** What a served commit holds of a judged one. */
export type Carriage =
  /** The served commit is the judged one or a descendant of it. */
  | { readonly kind: 'descends' }
  /** It is not: `paths` is every file the two trees may differ in, each side's since their merge base. */
  | { readonly kind: 'differs'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string };

/** The files a landing changed against its first parent. */
export type ChangedPaths =
  | { readonly kind: 'read'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string };

interface CompareFile {
  filename?: string;
  previous_filename?: string;
}

interface CompareRead {
  status?: string;
  files?: CompareFile[];
}

interface CommitRead {
  parents?: Array<{ sha?: string }>;
}

const DESCENDS = new Set(['ahead', 'identical']);

function keep<V>(held: Map<string, V>, key: string, value: V): void {
  held.delete(key);
  held.set(key, value);
  if (held.size <= CACHE_LIMIT) return;
  const oldest = held.keys().next().value;
  if (oldest !== undefined) held.delete(oldest);
}

const carried = new Map<string, Carriage>();
const changed = new Map<string, ChangedPaths>();

export function forgetCarriage(): void {
  carried.clear();
  changed.clear();
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Each file a compare names, a rename by both its names: the old path no longer holds it either.
 *  A reason where the list cannot be taken whole, since a missing list is not an empty one. */
function filesOf(read: CompareRead): string[] | string {
  if (!Array.isArray(read.files)) return 'the compare answered no file list';
  if (read.files.length >= COMPARE_FILE_CEILING) return TOO_MANY;
  const named = (p: unknown) => typeof p === 'string' && p !== '';
  const unnamed = read.files.some(
    (f) =>
      !named(f?.filename) || (f.previous_filename !== undefined && !named(f.previous_filename)),
  );
  if (unnamed) return 'the compare answered a file entry with no name';
  return read.files.flatMap((f) => [f.filename, f.previous_filename].filter(named) as string[]);
}

type Compared = { readonly status: string; readonly files: string[] } | { readonly why: string };

/** One compare, taken only whole: a status and the full file list, or the reason it is not. */
async function compare(client: GitHubRepoClient, base: string, head: string): Promise<Compared> {
  const read = await client.get<CompareRead>(
    `/repos/${client.fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  if (!read.status) return { why: `${client.fullName} answered no compare status` };
  const files = filesOf(read);
  if (typeof files === 'string') return { why: files };
  return { status: read.status, files };
}

async function readCarriage(
  client: GitHubRepoClient,
  judged: string,
  served: string,
): Promise<Carriage> {
  const forward = await compare(client, judged, served);
  if ('why' in forward) return { kind: 'unread', why: forward.why };
  if (DESCENDS.has(forward.status)) return { kind: 'descends' };
  const back = await compare(client, served, judged);
  if ('why' in back) return { kind: 'unread', why: back.why };
  return { kind: 'differs', paths: [...new Set([...forward.files, ...back.files])].sort() };
}

/** What `served` holds of `judged`; `spend` is asked only on a cache miss, and its reason answers. */
export async function carriageOf(
  client: GitHubRepoClient,
  judged: string,
  served: string,
  spend: () => string | null = () => null,
): Promise<Carriage> {
  const key = `${client.fullName}\u0000${judged.toLowerCase()}\u0000${served.toLowerCase()}`;
  const kept = carried.get(key);
  if (kept) return kept;
  const spent = spend();
  if (spent) return { kind: 'unread', why: spent };
  try {
    const read = await readCarriage(client, judged, served);
    if (read.kind !== 'unread') keep(carried, key, read);
    return read;
  } catch (err) {
    return {
      kind: 'unread',
      why: `${client.fullName} could not compare ${judged} with ${served}: ${why(err)}`,
    };
  }
}

async function readChanged(client: GitHubRepoClient, landing: string): Promise<ChangedPaths> {
  const commit = await client.get<CommitRead>(
    `/repos/${client.fullName}/commits/${encodeURIComponent(landing)}`,
  );
  const parent = commit.parents?.[0]?.sha;
  if (!parent) return { kind: 'unread', why: `${landing} has no parent to diff it against` };
  const read = await compare(client, parent, landing);
  if ('why' in read) return { kind: 'unread', why: read.why };
  return { kind: 'read', paths: [...new Set(read.files)].sort() };
}

export async function changedPathsOf(
  client: GitHubRepoClient,
  landing: string,
  spend: () => string | null = () => null,
): Promise<ChangedPaths> {
  const key = `${client.fullName}\u0000${landing.toLowerCase()}`;
  const kept = changed.get(key);
  if (kept) return kept;
  const spent = spend();
  if (spent) return { kind: 'unread', why: spent };
  try {
    const read = await readChanged(client, landing);
    if (read.kind === 'read') keep(changed, key, read);
    return read;
  } catch (err) {
    return {
      kind: 'unread',
      why: `${client.fullName} could not read what ${landing} changed: ${why(err)}`,
    };
  }
}
