// What a platform answers, as a person's reads of what waits on them may show it: the last reading
// observed, with the time it was read, not a fresh call to the platform on every read (ISS-1070 r13,
// r14). forge-dev's attention read asked each production binding's Coolify deployment list and
// runtime probe (`release-batch/serving-reading.ts`), and each storefront project's Autoflow drafts
// (`integrations/storefront-draft-read.ts`), on every request, and every area weighing one waited
// ~850 ms on it. A read a person makes changes nothing it reads, so it may be shown what was observed
// a moment ago, and it says when (`readAt`, VISION: state-never-lies):
// - younger than {@link FRESH_MS}: served as it was read;
// - younger than {@link TRUST_MS}: served as it was read, while a reading in the background replaces it;
// - older, never read, or not covering what is asked: never served. The read waits for a fresh
//   reading, which every read asking it at once shares, so one request asks each binding once at most.
// Outside a person's reads (a release, the sweep, a gate, a release page) every reading is fresh, and
// recorded here for the reads that follow.

import { AsyncLocalStorage } from 'node:async_hooks';
import { background } from '../lib/background.js';
import { logger } from '../lib/logger.js';
import { inReadMemo, withoutReadMemo } from './read-memo.js';

const observed = new AsyncLocalStorage<true>();

/**
 * Runs `fn` as a person's read of what waits on them (Needs you, attention, home): a reading of a
 * platform inside it may be one observed a moment ago and said so ({@link observedReading}), where
 * every other read reads it afresh.
 */
export function withObservedReads<T>(fn: () => T): T {
  return observed.run(true, fn);
}

/** Whether this code runs inside {@link withObservedReads}. */
export const observedReadsAllowed = (): boolean => observed.getStore() === true;

/** How long a reading is served as it was read, with no reading started. */
export const FRESH_MS = 30_000;

/** How long a reading may be served at all: one older is never shown, a fresh one is read first. */
export const TRUST_MS = 5 * 60_000;

interface Held {
  reading: unknown;
  /** When the read that answered it started: its age is never less than what it says. */
  at: number;
}

const held = new Map<string, Held>();
const reading = new Map<string, Promise<unknown>>();
const refreshes = background();

/** Whether a reading here may be one observed earlier: a person's read, inside a read request. */
const mayObserve = () => observedReadsAllowed() && inReadMemo();

/** Reads `key` afresh, and keeps the reading unless one started later is already kept. */
async function readAndKeep<T>(key: string, read: () => Promise<T>, now: () => number): Promise<T> {
  const at = now();
  const r = await read();
  const prior = held.get(key);
  if (!prior || prior.at <= at) held.set(key, { reading: r, at });
  return r;
}

/**
 * A person's fresh reading of `key`: every read asking it while one runs shares that one, where it
 * answers what the asker needs; one that does not is followed by a read of its own.
 */
async function readShared<T>(
  key: string,
  read: () => Promise<T>,
  now: () => number,
  covers: (r: T) => boolean,
): Promise<T> {
  const running = reading.get(key) as Promise<T> | undefined;
  if (running) {
    const shared = await running;
    if (covers(shared)) return shared;
    return readShared(key, read, now, covers);
  }
  const started = readAndKeep(key, read, now).finally(() => reading.delete(key));
  reading.set(key, started);
  return started;
}

/**
 * The reading `read` makes under `key` (a project's environment, a storefront binding), as a
 * person's read may be shown it ({@link withObservedReads}): observed earlier where it is still to be
 * trusted and `covers` what this ask needs of it, read afresh otherwise. Anywhere else it is read
 * afresh, and recorded. A reading says itself when it was read; the time it is shown never replaces it.
 */
export async function observedReading<T>(
  key: string,
  read: () => Promise<T>,
  now: () => number = Date.now,
  covers: (r: T) => boolean = () => true,
): Promise<T> {
  // a release, a gate or a page about one reads what is answered now, never a reading shared or kept
  if (!mayObserve()) return readAndKeep(key, read, now);
  const last = held.get(key);
  const age = last === undefined ? Number.POSITIVE_INFINITY : now() - last.at;
  if (last === undefined || age >= TRUST_MS || !covers(last.reading as T)) {
    // too old to show as what is answered, or never asked this: a person waits for a fresh reading
    return readShared(key, read, now, covers);
  }
  if (age >= FRESH_MS && !reading.has(key)) {
    refreshes.start(
      () => withoutReadMemo(() => readShared(key, read, now, () => true)),
      (err) => logger.warn({ err, key }, 'a reading refreshed in the background failed'),
    );
  }
  return last.reading as T;
}
