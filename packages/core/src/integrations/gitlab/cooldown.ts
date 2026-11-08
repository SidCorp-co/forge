/**
 * The wait a GitLab host named on a 429, kept so no call from this process goes back sooner
 * (forge-core-61, 2026-10-30: dev core drew 1,884 429s in ten minutes and asked again at once each
 * time). A 429 naming its limit (`RateLimit-Name`, e.g. `burst_traffic_per_user_free_plan`) holds the
 * token that drew it; one naming none (GitLab's plain "Too many requests", Retry-After 60) is read as
 * the host refusing this address, and holds every token on that host. The wait is the host's
 * `Retry-After`, else its `RateLimit-Reset`, else a minute.
 *
 * A background caller (a sweep, a webhook's follow-up: a `kernel` host) waits longer than the host
 * named, a minute past it on the first 429 and doubling on each repeat inside half an hour, up to
 * half an hour (ISS-1144, FB-582: a master's change-request read was refused 429 on every pass for
 * 23 hours, the window each wait opened spent before the read could take it). The read someone
 * waits on takes the window first.
 */

import { createHash } from 'node:crypto';

const DEFAULT_WAIT_MS = 60_000;
/** A wait the host names past this is clamped, so one garbled header cannot hold a host for a day. */
const MAX_WAIT_MS = 15 * 60_000;

const until = new Map<string, number>();
/** How long past the host's wait a background caller is held, and the 429s that set it. */
const STRIKE_WINDOW_MS = 30 * 60_000;
const MAX_BACKGROUND_EXTRA_MS = 30 * 60_000;
const backgroundUntil = new Map<string, number>();
const strikes = new Map<string, { n: number; at: number }>();

const tokenKey = (host: string, token: string) =>
  `${host}#${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

/** When the host said a refused call may be tried again, read from its 429's headers. */
export function retryAtOf(headers: Headers, now = Date.now()): number {
  const after = headers.get('retry-after');
  if (after !== null) {
    const secs = Number(after);
    if (Number.isFinite(secs) && secs >= 0) return now + Math.min(secs * 1000, MAX_WAIT_MS);
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.min(Math.max(date, now), now + MAX_WAIT_MS);
  }
  const reset = Number(headers.get('ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000, now), now + MAX_WAIT_MS);
  }
  return now + DEFAULT_WAIT_MS;
}

/** Record a 429 from `host` answered to `token`: until when calls on it are held. */
export function holdAfter429(
  host: string,
  token: string,
  headers: Headers,
  now = Date.now(),
): Date {
  const at = retryAtOf(headers, now);
  const scoped = headers.get('ratelimit-name') !== null;
  const key = scoped ? tokenKey(host, token) : host;
  until.set(key, Math.max(until.get(key) ?? 0, at));
  const last = strikes.get(key);
  const n = last && now - last.at < STRIKE_WINDOW_MS ? last.n + 1 : 1;
  strikes.set(key, { n, at: now });
  const extra = Math.min(DEFAULT_WAIT_MS * 2 ** (n - 1), MAX_BACKGROUND_EXTRA_MS);
  backgroundUntil.set(key, Math.max(backgroundUntil.get(key) ?? 0, at + extra));
  return new Date(at);
}

/**
 * Until when a call to `host` as `token` is held, or null where it may go now: a `background`
 * caller's hold runs past the host's own wait (above).
 */
export function heldUntil(
  host: string,
  token: string,
  now = Date.now(),
  background = false,
): Date | null {
  let latest = 0;
  for (const key of [host, tokenKey(host, token)]) {
    for (const held of background ? [until, backgroundUntil] : [until]) {
      const t = held.get(key);
      if (t === undefined) continue;
      if (t <= now) held.delete(key);
      else latest = Math.max(latest, t);
    }
  }
  return latest > 0 ? new Date(latest) : null;
}

/** Test seam: forget every hold. */
export function clearGitLabHolds(): void {
  until.clear();
  backgroundUntil.clear();
  strikes.clear();
}
