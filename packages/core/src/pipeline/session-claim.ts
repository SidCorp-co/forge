/** Which run may write one issue's record, from `issues.session_context.lease` — NOT who holds the
 *  key out of the fleet's pool (`issue_leases`). A wall clock, because a CLI run can die with
 *  nothing marking a row terminal. */

// cm:edge naming -> packages/core/src/issues/issue-lease.ts — different questions, once the same
//   word `issue-lease`. Grepping either name must reach only one of them.

// cm:edge contract -> github.com/SidCorp-co/forge-plugin:plugin/src/flow/lease.mjs — that file owns
//   the blob: `holder`, `renewedAt`, `minutes`, optional `stopped`, expiry `renewedAt + minutes`.
//   Any other shape is `malformed`, which is report-only. A change there has its second half here.
export const LEASE_VERDICTS = ['none', 'live', 'shared', 'expired', 'malformed'] as const;
export type LeaseVerdict = (typeof LEASE_VERDICTS)[number];

export interface LeaseReading {
  verdict: LeaseVerdict;
  holder: string | null;
  expiresAt: Date | null;
  fanout: number;
  stopped: boolean;
  detail: string;
}

export function leaseHolderOf(lease: unknown): string | null {
  if (typeof lease !== 'object' || lease === null || Array.isArray(lease)) return null;
  const holder = (lease as Record<string, unknown>).holder;
  return typeof holder === 'string' && holder.length > 0 ? holder : null;
}

/** Separate from {@link classifyLease}: a fanout that consulted one would be mutually recursive. */
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

export function leaseIsWorkInProgress(verdict: LeaseVerdict): boolean {
  return verdict === 'live';
}

/** `expired` alone: releasing a `malformed` or `shared` claim hands a live run's issue to a second
 *  one. A stamped claim is not released twice, or each tick appends a `swept` entry. */
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
