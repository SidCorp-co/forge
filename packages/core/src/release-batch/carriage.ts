/**
 * Whether a served commit carries a judged one, and which paths a landing changed, read from the
 * project's own repository through its source host (ISS-1368). A served commit that equals the
 * judged one is decided without asking anything; every other pair is one compare, or two where the
 * served commit does not descend from the judged one and the files their trees differ in have to
 * be named.
 *
 * Whether the served commit descends from the judged one is asked first, as one compare; the files
 * two commits differ in are paged through only when it does not, since a judged commit weeks behind
 * the served one can differ in thousands of files and every page is a call.
 *
 * Whatever GitHub answered about two named commits, or one commit's own diff, is content-addressed
 * and never changes — a list too long to take whole included — so it is kept for the process,
 * bounded, oldest out first. A request that failed is a reading about the moment and is never kept.
 * A pair with no common ancestor arrives as a failed request and is unread like any other.
 */

import type { HostFileChange, SourceHost } from '../integrations/source-host/index.js';
import type { Carriage, ChangedPaths } from '../issues/index.js';

const CACHE_LIMIT = 2000;

const DESCENDS = new Set(['ahead', 'identical']);

function keep<V>(held: Map<string, V>, key: string, value: V): void {
  held.delete(key);
  held.set(key, value);
  if (held.size <= CACHE_LIMIT) return;
  const oldest = held.keys().next().value;
  if (oldest !== undefined) held.delete(oldest);
}

const carried = new Map<string, Carriage>();
const changed = new Map<string, ChangedFiles>();

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readCarriage(host: SourceHost, judged: string, served: string): Promise<Carriage> {
  if (DESCENDS.has(await host.compare(judged, served))) return { kind: 'descends' };
  const forward = await host.compareFiles(judged, served);
  if ('why' in forward) return { kind: 'unread', why: forward.why };
  const back = await host.compareFiles(served, judged);
  if ('why' in back) return { kind: 'unread', why: back.why };
  return { kind: 'differs', paths: [...new Set([...forward.files, ...back.files])].sort() };
}

/** What `served` holds of `judged`; `spend` is asked only on a cache miss, and its reason answers. */
export async function carriageOf(
  host: SourceHost,
  judged: string,
  served: string,
  spend: () => string | null = () => null,
): Promise<Carriage> {
  const key = `${host.fullName}\u0000${judged.toLowerCase()}\u0000${served.toLowerCase()}`;
  const kept = carried.get(key);
  if (kept) return kept;
  const spent = spend();
  if (spent) return { kind: 'unread', why: spent };
  try {
    const read = await readCarriage(host, judged, served);
    keep(carried, key, read);
    return read;
  } catch (err) {
    return {
      kind: 'unread',
      why: `${host.fullName} could not compare ${judged} with ${served}: ${why(err)}`,
    };
  }
}

/** The files a landing changed and what became of each, or why they were not read. */
type ChangedFiles =
  | {
      readonly kind: 'read';
      readonly paths: readonly string[];
      readonly changes: readonly HostFileChange[];
    }
  | { readonly kind: 'unread'; readonly why: string };

export async function changedFilesOf(
  host: SourceHost,
  landing: string,
  spend: () => string | null = () => null,
): Promise<ChangedFiles> {
  const key = `${host.fullName}\u0000${landing.toLowerCase()}`;
  const kept = changed.get(key);
  if (kept) return kept;
  const spent = spend();
  if (spent) return { kind: 'unread', why: spent };
  try {
    const read = await host.commitFiles(landing);
    const files: ChangedFiles =
      'why' in read
        ? { kind: 'unread', why: read.why }
        : { kind: 'read', paths: [...new Set(read.files)].sort(), changes: read.changes };
    keep(changed, key, files);
    return files;
  } catch (err) {
    return {
      kind: 'unread',
      why: `${host.fullName} could not read what ${landing} changed: ${why(err)}`,
    };
  }
}

export async function changedPathsOf(
  host: SourceHost,
  landing: string,
  spend: () => string | null = () => null,
): Promise<ChangedPaths> {
  const read = await changedFilesOf(host, landing, spend);
  return read.kind === 'read' ? { kind: 'read', paths: read.paths } : read;
}
