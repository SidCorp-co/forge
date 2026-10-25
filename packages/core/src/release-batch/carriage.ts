/**
 * What a served commit carries of a judged one, what a landing changed (ISS-1368, ISS-1398), and
 * whether the repository holds a recorded landing (ISS-1300).
 * An answer about named commits never changes, so it is kept, bounded; a failure is never kept.
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
const held = new Map<string, true>();

export function forgetCarriage(): void {
  carried.clear();
  changed.clear();
  held.clear();
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

/** Whether the repository holds `commit` (ISS-1300). Only a commit found is kept: one absent may be
 *  pushed later, so it is asked again, and a failed read or a spent budget answers `unread`. */
export async function landingHeld(
  reader: RepositoryReader,
  commit: string,
  spend: () => string | null = () => null,
): Promise<'found' | 'absent' | 'unread'> {
  const key = `${reader.name}\u0000${commit.trim().toLowerCase()}`;
  if (held.has(key)) return 'found';
  if (spend()) return 'unread';
  const looked = await reader.commit(commit.trim());
  if (looked.kind === 'found') keep(held, key, true);
  return looked.kind === 'unreadable' ? 'unread' : looked.kind;
}
