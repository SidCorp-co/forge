/**
 * Whether a served commit carries a judged one, and which paths a landing changed, read from the
 * project's own repository (ISS-1368) through whichever reader answers for it (ISS-1398). A served
 * commit that equals the judged one is decided without asking anything.
 *
 * A successful answer about two named commits, or one commit's own diff, is content-addressed and
 * never changes, so it is kept for the process, bounded, oldest out first; a failure is a reading
 * about the moment and is never kept.
 */

import type { Carriage, ChangedPaths, RepositoryReader } from '../projects/repository-reader.js';

const CACHE_LIMIT = 2000;

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

/** What `served` holds of `judged`; `spend` is asked only on a cache miss, and its reason answers. */
export async function carriageOf(
  reader: RepositoryReader,
  judged: string,
  served: string,
  spend: () => string | null = () => null,
): Promise<Carriage> {
  const key = `${reader.name}\u0000${judged.toLowerCase()}\u0000${served.toLowerCase()}`;
  const kept = carried.get(key);
  if (kept) return kept;
  const spent = spend();
  if (spent) return { kind: 'unread', why: spent };
  const read = await reader.carriage(judged, served);
  if (read.kind !== 'unread') keep(carried, key, read);
  return read;
}

export async function changedPathsOf(
  reader: RepositoryReader,
  landing: string,
  spend: () => string | null = () => null,
): Promise<ChangedPaths> {
  const key = `${reader.name}\u0000${landing.toLowerCase()}`;
  const kept = changed.get(key);
  if (kept) return kept;
  const spent = spend();
  if (spent) return { kind: 'unread', why: spent };
  const read = await reader.changedPaths(landing);
  if (read.kind === 'read') keep(changed, key, read);
  return read;
}
