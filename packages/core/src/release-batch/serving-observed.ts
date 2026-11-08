// What a project's production (or judged-on environment) serves, as a person's reads of what waits on
// them may show it: the last reading observed, with the time it was read, not a fresh call to the
// platform on every read (ISS-1070 r13). forge-dev's attention read asked each production binding's
// Coolify deployment list and runtime probe twice a request, once for a requirement's coverage and
// once for a release's criteria basis (`criteria-basis.ts:criteriaBasisOf`), and every needs-you area
// that weighs one waited ~850 ms on it. A read a person makes changes nothing it reads, so it may be
// shown what was observed a moment ago, and it says when (`readAt`, VISION: state-never-lies):
// - younger than {@link FRESH_MS}: served as it was read;
// - younger than {@link TRUST_MS}: served as it was read, while a reading in the background replaces it;
// - older, or never read: never served. The read waits for a fresh reading, which every read asking
//   it at once shares, so one request asks each binding once at most.
// Outside a person's reads (a release, the sweep, a gate, a release page) every reading is fresh, and
// recorded here for the reads that follow.

import type { ServingReading } from '@forge/contracts/releases';
import { inReadMemo, observedReadsAllowed, withoutReadMemo } from '../db/read-memo.js';
import { background } from '../lib/background.js';
import { logger } from '../lib/logger.js';

/** How long a reading is served as it was read, with no reading started. */
export const FRESH_MS = 30_000;

/** How long a reading may be served at all: one older is never shown, a fresh one is read first. */
export const TRUST_MS = 5 * 60_000;

interface Held {
  reading: ServingReading;
  /** When the read that answered it started: its age is never less than what it says. */
  at: number;
}

const held = new Map<string, Held>();
const reading = new Map<string, Promise<ServingReading>>();
const refreshes = background();

/**
 * Whether a reading here may be one observed earlier: a person's read of what waits on them
 * (`db/read-memo.ts:withObservedReads`), inside a read request.
 */
const mayObserve = () => observedReadsAllowed() && inReadMemo();

/** Reads `key` afresh, and keeps the reading unless one started later is already kept. */
async function readAndKeep(
  key: string,
  read: () => Promise<ServingReading>,
  now: () => number,
): Promise<ServingReading> {
  const at = now();
  const r = await read();
  const prior = held.get(key);
  if (!prior || prior.at <= at) held.set(key, { reading: r, at });
  return r;
}

/** A person's fresh reading of `key`: every read asking it while one runs shares that one. */
function readShared(
  key: string,
  read: () => Promise<ServingReading>,
  now: () => number,
): Promise<ServingReading> {
  const running = reading.get(key);
  if (running) return running;
  const started = readAndKeep(key, read, now).finally(() => reading.delete(key));
  reading.set(key, started);
  return started;
}

/**
 * The reading `read` makes under `key` (a project, the environment and its declaration), as a
 * person's read may be shown it (`db/read-memo.ts:withObservedReads`): observed earlier where it is still to be
 * trusted, read afresh otherwise. Anywhere else it is read afresh, and recorded.
 */
export async function observedReading(
  key: string,
  read: () => Promise<ServingReading>,
  now: () => number = Date.now,
): Promise<ServingReading> {
  // a release, a gate or a page about one reads what is served now, never a reading shared or kept
  if (!mayObserve()) return readAndKeep(key, read, now);
  const last = held.get(key);
  const age = last === undefined ? Number.POSITIVE_INFINITY : now() - last.at;
  if (last === undefined || age >= TRUST_MS) {
    // too old to show as what is served: a person waits for a fresh reading rather than see it
    return readShared(key, read, now);
  }
  if (age >= FRESH_MS && !reading.has(key)) {
    refreshes.start(
      () => withoutReadMemo(() => readShared(key, read, now)),
      (err) => logger.warn({ err, key }, 'a served reading refreshed in the background failed'),
    );
  }
  return last.reading;
}
