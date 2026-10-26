/**
 * What a served commit carries of a judged one, and what a landing changed (ISS-1368, ISS-1398).
 * An answer about named commits is kept, bounded, by reader `reach` (ISS-1300 r4); a failure isn't.
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
/** When each commit was last found: possession, unlike content, can change once a repository is
 *  rewritten, so a found answer is trusted for an hour and then asked again. */
const held = new Map<string, number>();
const HELD_FOR_MS = 60 * 60 * 1000;

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
  const key = `${reader.reach}\u0000${judged.toLowerCase()}\u0000${served.toLowerCase()}`;
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
  const key = `${reader.reach}\u0000${landing.toLowerCase()}`;
  const kept = changed.get(key);
  if (kept) return kept;
  const spent = spend();
  if (spent) return { kind: 'unread', why: spent };
  const read = await reader.changedPaths(landing);
  if (read.kind === 'read') keep(changed, key, read);
  return read;
}

/** Whether the repository holds `commit` (ISS-1300). Only a commit found is kept, for an hour: one
 *  absent may be pushed later, so it is asked again. A spent budget answers `spent`, and a read the
 *  repository refused answers why, which is the repository's to clear and not this weighing's.
 *  `now` is the clock the hour is read on. */
export async function landingHeld(
  reader: RepositoryReader,
  commit: string,
  spend: () => string | null = () => null,
  now: () => number = Date.now,
): Promise<'found' | 'absent' | 'spent' | { unreadable: string }> {
  const key = `${reader.reach}\u0000${commit.trim().toLowerCase()}`;
  const foundAt = held.get(key);
  if (foundAt !== undefined && now() - foundAt < HELD_FOR_MS) return 'found';
  if (spend()) return 'spent';
  const looked = await reader.commit(commit.trim());
  if (looked.kind === 'found') keep(held, key, now());
  else held.delete(key);
  return looked.kind === 'unreadable' ? { unreadable: looked.why } : looked.kind;
}
