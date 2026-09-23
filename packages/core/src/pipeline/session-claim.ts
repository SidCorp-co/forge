/** Which run may write one issue's record, from `issues.session_context.lease` — NOT who holds the
 *  fleet's key (`issue_leases`). A wall clock, or the holder's heartbeat where it declared one. */

// cm:edge naming -> packages/core/src/issues/issue-lease.ts — different questions, once the same
//   word `issue-lease`. Grepping either name must reach only one of them.

// cm:edge contract -> github.com/SidCorp-co/forge-plugin:plugin/src/flow/lease.mjs — that file owns
//   the blob: `holder`, `renewedAt`, `minutes`, optional `stopped` and `heartbeat: { at,
//   everySeconds }`; expiry `renewedAt + minutes`, any other shape `malformed`, report-only.
export const LEASE_VERDICTS = [
  'none',
  'live',
  'shared',
  'expired',
  'abandoned',
  'malformed',
] as const;
export type LeaseVerdict = (typeof LEASE_VERDICTS)[number];

/** Periods a holder may miss; the floor under that against jitter; how far ahead a beat may be. */
export const MISSED_BEATS = 3;
export const MIN_SILENCE_MS = 60_000;
export const FUTURE_BEAT_TOLERANCE_MS = 60_000;

export function leaseSilenceToleranceMs(everySeconds: number): number {
  return Math.max(everySeconds * 1000 * MISSED_BEATS, MIN_SILENCE_MS);
}

export interface LeaseReading {
  verdict: LeaseVerdict;
  holder: string | null;
  expiresAt: Date | null;
  fanout: number;
  stopped: boolean;
  /** How long the holder has been quiet, `null` where no heartbeat was read to be quiet against. */
  silentMs: number | null;
  detail: string;
}

export function leaseHolderOf(lease: unknown): string | null {
  if (typeof lease !== 'object' || lease === null || Array.isArray(lease)) return null;
  const holder = (lease as Record<string, unknown>).holder;
  return typeof holder === 'string' && holder.length > 0 ? holder : null;
}

/** Separate from {@link classifyLease}: a fanout consulting one would be mutually recursive. Base
 *  fields only — an unreadable heartbeat here would change the verdict of a lease carrying none. */
export function leaseIsUnexpired(lease: unknown, now: Date): boolean {
  const read = readLeaseFields(lease);
  return read.ok && read.stopped === null && read.expiresAt.getTime() > now.getTime();
}

/** `fanout` separates `live` from `shared`; `shared` is an observation and claims no liveness. */
export function classifyLease(args: { lease: unknown; now: Date; fanout: number }): LeaseReading {
  const { lease, now, fanout } = args;
  const holder = leaseHolderOf(lease);

  if (lease === null || lease === undefined) {
    return {
      verdict: 'none',
      holder: null,
      expiresAt: null,
      fanout: 0,
      stopped: false,
      silentMs: null,
      detail: '',
    };
  }

  const read = readLeaseFields(lease);
  if (!read.ok) return malformed({ holder, fanout, detail: read.detail });

  const rest = { holder, expiresAt: read.expiresAt, fanout, silentMs: null, detail: '' };
  if (read.stopped !== null) return { ...rest, verdict: 'expired', stopped: true };
  if (read.expiresAt.getTime() <= now.getTime()) {
    return { ...rest, verdict: 'expired', stopped: false };
  }

  // After the expiry tests, unlike the base fields: a holder writing a bad heartbeat must not make
  // every lapsed claim unreleasable, which is this module's own defect back under a new cause.
  const beat = readHeartbeat(lease, now);
  if (!beat.ok) return malformed({ holder, fanout, detail: beat.detail });
  const beating = { ...rest, silentMs: beat.silentMs };
  if (beat.silentMs !== null && beat.silentMs > leaseSilenceToleranceMs(beat.everySeconds)) {
    return { ...beating, verdict: 'abandoned', stopped: false };
  }

  if (fanout > 1) return { ...beating, verdict: 'shared', stopped: false };
  return { ...beating, verdict: 'live', stopped: false };
}

function malformed(args: { holder: string | null; fanout: number; detail: string }): LeaseReading {
  return {
    verdict: 'malformed',
    holder: args.holder,
    expiresAt: null,
    fanout: args.fanout,
    stopped: false,
    silentMs: null,
    detail: args.detail,
  };
}

export function leaseIsWorkInProgress(verdict: LeaseVerdict): boolean {
  return verdict === 'live';
}

/** A status grace is a proxy for nobody being on the row and a breached heartbeat measures that
 *  directly, so a caller holding one need not wait the proxy out as well. */
export function leaseShowsHolderGone(verdict: LeaseVerdict): boolean {
  return verdict === 'abandoned';
}

/** `expired` and `abandoned`: releasing a `malformed` or `shared` claim hands a live run's issue to
 *  a second one. A stamped claim is not released twice, or each tick appends a `swept` entry. */
export function leaseIsReleasable(reading: LeaseReading): boolean {
  return (reading.verdict === 'expired' || reading.verdict === 'abandoned') && !reading.stopped;
}

type LeaseFields =
  | { ok: true; expiresAt: Date; stopped: string | null }
  | { ok: false; detail: string };

function readLeaseFields(lease: unknown): LeaseFields {
  if (typeof lease !== 'object' || lease === null || Array.isArray(lease)) {
    return { ok: false, detail: `lease is ${Array.isArray(lease) ? 'an array' : typeof lease}` };
  }
  const obj = lease as Record<string, unknown>;

  if (leaseHolderOf(lease) === null) {
    return { ok: false, detail: 'holder is not a non-empty string' };
  }

  const renewedAt = obj.renewedAt;
  if (typeof renewedAt !== 'string' || Number.isNaN(Date.parse(renewedAt))) {
    return { ok: false, detail: 'renewedAt is not a parseable timestamp' };
  }

  const minutes = obj.minutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, detail: 'minutes is not a positive finite number' };
  }

  const stopped = obj.stopped;
  if (stopped !== undefined && stopped !== null && typeof stopped !== 'string') {
    return { ok: false, detail: 'stopped is neither null nor a string' };
  }

  return {
    ok: true,
    expiresAt: new Date(Date.parse(renewedAt) + minutes * 60_000),
    stopped: typeof stopped === 'string' ? stopped : null,
  };
}

type HeartbeatFields =
  | { ok: true; silentMs: number | null; everySeconds: number }
  | { ok: false; detail: string };

/** Absent is no signal: a run that declared no period made no promise. A beat too far ahead is
 *  refused rather than clamped — absorbed, it reads fresh for as long as the gap lasts. */
function readHeartbeat(lease: unknown, now: Date): HeartbeatFields {
  const beat = (lease as Record<string, unknown>).heartbeat;
  if (beat === undefined || beat === null) return { ok: true, silentMs: null, everySeconds: 0 };
  if (typeof beat !== 'object' || Array.isArray(beat)) {
    return { ok: false, detail: `heartbeat is ${Array.isArray(beat) ? 'an array' : typeof beat}` };
  }
  const obj = beat as Record<string, unknown>;

  const at = obj.at;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    return { ok: false, detail: 'heartbeat.at is not a parseable timestamp' };
  }

  const everySeconds = obj.everySeconds;
  if (typeof everySeconds !== 'number' || !Number.isFinite(everySeconds) || everySeconds <= 0) {
    return { ok: false, detail: 'heartbeat.everySeconds is not a positive finite number' };
  }

  const silentMs = now.getTime() - Date.parse(at);
  if (silentMs < -FUTURE_BEAT_TOLERANCE_MS) {
    return {
      ok: false,
      detail: `heartbeat.at is ${Math.round(-silentMs / 1000)}s ahead of this reader`,
    };
  }
  return { ok: true, silentMs: Math.max(silentMs, 0), everySeconds };
}
