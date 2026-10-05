/**
 * Whether a served commit carries a judged one, and which paths a landing changed, read from the
 * project's own repository through its source host (ISS-1368). A served commit that equals the
 * judged one is decided without asking anything; every other pair is one compare, or two where the
 * served commit does not descend from the judged one and the files their trees differ in have to
 * be named.
 *
 * A successful answer about two named commits, or one commit's own diff, is content-addressed and
 * never changes, so it is kept for the process, bounded, oldest out first; a failure is a reading
 * about the moment and is never kept. A pair with no common ancestor arrives as a failed request
 * and is unread like any other.
 */

import type { SourceHost } from '../integrations/source-host/index.js';
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
const changed = new Map<string, ChangedPaths>();

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readCarriage(host: SourceHost, judged: string, served: string): Promise<Carriage> {
  const forward = await host.compareFiles(judged, served);
  if ('why' in forward) return { kind: 'unread', why: forward.why };
  if (DESCENDS.has(forward.status)) return { kind: 'descends' };
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
    if (read.kind !== 'unread') keep(carried, key, read);
    return read;
  } catch (err) {
    return {
      kind: 'unread',
      why: `${host.fullName} could not compare ${judged} with ${served}: ${why(err)}`,
    };
  }
}

export async function changedPathsOf(
  host: SourceHost,
  landing: string,
  spend: () => string | null = () => null,
): Promise<ChangedPaths> {
  const key = `${host.fullName}\u0000${landing.toLowerCase()}`;
  const kept = changed.get(key);
  if (kept) return kept;
  const spent = spend();
  if (spent) return { kind: 'unread', why: spent };
  try {
    const read = await host.commitFiles(landing);
    if ('why' in read) return { kind: 'unread', why: read.why };
    const paths: ChangedPaths = { kind: 'read', paths: [...new Set(read.files)].sort() };
    keep(changed, key, paths);
    return paths;
  } catch (err) {
    return {
      kind: 'unread',
      why: `${host.fullName} could not read what ${landing} changed: ${why(err)}`,
    };
  }
}
