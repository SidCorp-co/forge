/**
 * What core reads out of `issues.session_context->'lease'`.
 *
 * The field is written by the `forge` CLI in `github.com/SidCorp-co/forge-plugin`, which owns its
 * shape; this module is the only place core states what it reads out of it, and it reads
 * defensively. Every field it cannot parse produces {@link classifyLease}'s `malformed`, which is
 * report-only: a lease core cannot read is unknown validity, and unknown validity is not permission
 * to take somebody's lock away.
 */

/** The verdicts {@link classifyLease} may return, each a statement about what core can see. */
export const LEASE_VERDICTS = ['none', 'live', 'shared', 'expired', 'malformed'] as const;
export type LeaseVerdict = (typeof LEASE_VERDICTS)[number];

export interface LeaseReading {
  verdict: LeaseVerdict;
  /** The holder id as read, or null where there is none or it could not be read. */
  holder: string | null;
  /** When the lease lapses by its own terms, where that was readable. */
  expiresAt: Date | null;
  /** How many non-terminal issues hold an unexpired lease under this holder, this one included. */
  fanout: number;
  /** Whether the lease already carries a release stamp, so releasing it again would write twice. */
  stopped: boolean;
  /** For `malformed`, which field could not be read and why. Empty otherwise. */
  detail: string;
}

/**
 * The holder id, for the fanout query — read without judging the rest of the lease, because a
 * malformed lease still has a holder whose other issues are worth counting.
 */
export function leaseHolderOf(lease: unknown): string | null {
  if (typeof lease !== 'object' || lease === null || Array.isArray(lease)) return null;
  const holder = (lease as Record<string, unknown>).holder;
  return typeof holder === 'string' && holder.length > 0 ? holder : null;
}

/**
 * Whether this lease has lapsed by its own terms, for the fanout count.
 *
 * Deliberately separate from {@link classifyLease}: counting how many issues a holder is on must
 * not itself depend on a fanout, or the two would be mutually recursive.
 */
export function leaseIsUnexpired(lease: unknown, now: Date): boolean {
  const read = readLeaseFields(lease);
  return read.ok && read.stopped === null && read.expiresAt.getTime() > now.getTime();
}

/**
 * One lease, judged.
 *
 * `fanout` is how many non-terminal issues hold an unexpired lease under the same holder id, this
 * one included, and it is what separates `live` from `shared`. `forge claim`'s own warning is that
 * an id on several issues at once may be the session that dispatched a wave and "is no proof
 * another run is not on this issue"; it may equally be one run holding a legitimate batch. Core
 * cannot tell those apart from here, so `shared` names the observation and claims nothing about
 * whether a run is alive.
 */
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
      detail: '',
    };
  }

  const read = readLeaseFields(lease);
  if (!read.ok) {
    return {
      verdict: 'malformed',
      holder,
      expiresAt: null,
      fanout,
      stopped: false,
      detail: read.detail,
    };
  }

  const rest = { holder, expiresAt: read.expiresAt, fanout, detail: '' };
  if (read.stopped !== null) return { ...rest, verdict: 'expired', stopped: true };
  if (read.expiresAt.getTime() <= now.getTime()) {
    return { ...rest, verdict: 'expired', stopped: false };
  }
  if (fanout > 1) return { ...rest, verdict: 'shared', stopped: false };
  return { ...rest, verdict: 'live', stopped: false };
}

/**
 * The one verdict that counts as a run being on this issue.
 *
 * `shared`, `expired`, `malformed` and `none` are each a reason the lease is not evidence, and a
 * row whose only sign of life is one of them has nothing working it.
 */
export function leaseIsWorkInProgress(verdict: LeaseVerdict): boolean {
  return verdict === 'live';
}

/**
 * The one verdict the sweep may release.
 *
 * `expired` alone, because it is the only one where the lease's own terms say the holder no longer
 * holds. `malformed` is unreadable rather than dead and `shared` may still be being renewed —
 * releasing either would hand a live run's issue to a second one.
 *
 * A lease that already carries the stamp is not released again: a pass that rewrote it every tick
 * would append a `swept` entry a minute to its history for as long as the row stood.
 */
export function leaseIsReleasable(reading: LeaseReading): boolean {
  return reading.verdict === 'expired' && !reading.stopped;
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
