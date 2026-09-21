import { describe, expect, it } from 'vitest';
import type { LeaseReading, LeaseVerdict } from './session-claim.js';
import {
  classifyLease,
  leaseHolderOf,
  leaseIsReleasable,
  leaseIsUnexpired,
  leaseIsWorkInProgress,
} from './session-claim.js';

const NOW = new Date('2026-09-20T16:00:00.000Z');

function lease(over: Record<string, unknown> = {}) {
  return {
    holder: '3f3ce366-efde-4a30-b427-8fe1f9e99809',
    renewedAt: '2026-09-20T15:45:00.000Z',
    minutes: 60,
    stopped: null,
    ...over,
  };
}

describe('classifyLease (ISS-1122)', () => {
  it('reads no lease as `none`', () => {
    expect(classifyLease({ lease: null, now: NOW, fanout: 0 }).verdict).toBe('none');
    expect(classifyLease({ lease: undefined, now: NOW, fanout: 0 }).verdict).toBe('none');
  });

  it('counts an unexpired lease on one issue as `live`', () => {
    const read = classifyLease({ lease: lease(), now: NOW, fanout: 1 });
    expect(read.verdict).toBe('live');
    expect(leaseIsWorkInProgress(read.verdict)).toBe(true);
    expect(read.expiresAt?.toISOString()).toBe('2026-09-20T16:45:00.000Z');
  });

  /**
   * ISS-1122, instance 3 — ISS-1106/1107/1108 sat `in_progress` under one holder id, which
   * `forge claim` itself warns "names a wave and not a run". The detector must not believe what
   * the CLI disclaims.
   */
  it('reads a holder on more than one issue as `shared`, not as a run in progress', () => {
    const read = classifyLease({ lease: lease(), now: NOW, fanout: 3 });
    expect(read.verdict).toBe('shared');
    expect(read.fanout).toBe(3);
    expect(leaseIsWorkInProgress(read.verdict)).toBe(false);
  });

  it('reads a lease past renewedAt + minutes as `expired`', () => {
    const read = classifyLease({
      lease: lease({ renewedAt: '2026-09-20T13:23:00.000Z' }),
      now: NOW,
      fanout: 1,
    });
    expect(read.verdict).toBe('expired');
    expect(leaseIsWorkInProgress(read.verdict)).toBe(false);
  });

  it('reads a lease already carrying `stopped` as `expired` however fresh its renewal', () => {
    const read = classifyLease({
      lease: lease({ stopped: '2026-09-20T15:50:00.000Z' }),
      now: NOW,
      fanout: 1,
    });
    expect(read.verdict).toBe('expired');
  });

  it.each([
    ['holder missing', lease({ holder: undefined }), 'holder'],
    ['holder empty', lease({ holder: '' }), 'holder'],
    ['renewedAt not a timestamp', lease({ renewedAt: 'whenever' }), 'renewedAt'],
    ['renewedAt not a string', lease({ renewedAt: 1758384000000 }), 'renewedAt'],
    ['minutes not a number', lease({ minutes: '60' }), 'minutes'],
    ['minutes not positive', lease({ minutes: 0 }), 'minutes'],
    ['stopped a number', lease({ stopped: 12 }), 'stopped'],
    ['lease a string', 'held', 'lease is string'],
    ['lease an array', [lease()], 'lease is an array'],
  ])('reads a lease whose %s as `malformed`, naming the field', (_name, value, names) => {
    const read = classifyLease({ lease: value, now: NOW, fanout: 1 });
    expect(read.verdict).toBe('malformed');
    expect(read.detail).toContain(names);
  });

  it('never counts anything but `live` as work in progress', () => {
    for (const v of ['none', 'shared', 'expired', 'malformed'] as const) {
      expect(leaseIsWorkInProgress(v)).toBe(false);
    }
  });

  /**
   * The consult's F1: unknown validity is not permission to take a lock away. A lease core cannot
   * read may still be held by a live run, so only a lease whose own terms say it has lapsed is
   * releasable.
   */
  it('makes `expired` the only releasable verdict', () => {
    const at = (verdict: LeaseVerdict, stopped = false): LeaseReading => ({
      verdict,
      holder: 'h',
      expiresAt: null,
      fanout: 1,
      stopped,
      detail: '',
    });
    expect(leaseIsReleasable(at('expired'))).toBe(true);
    for (const v of ['none', 'live', 'shared', 'malformed'] as const) {
      expect(leaseIsReleasable(at(v))).toBe(false);
    }
  });

  /** A lease already carrying the stamp would otherwise gain a `swept` history entry every tick. */
  it('does not release a lease that already carries the release stamp', () => {
    const read = classifyLease({
      lease: lease({ stopped: '2026-09-20T15:50:00.000Z' }),
      now: NOW,
      fanout: 1,
    });
    expect(read.verdict).toBe('expired');
    expect(read.stopped).toBe(true);
    expect(leaseIsReleasable(read)).toBe(false);
  });
});

describe('leaseHolderOf and leaseIsUnexpired (ISS-1122)', () => {
  it('reads the holder off a lease the rest of which is unreadable', () => {
    expect(leaseHolderOf(lease({ minutes: 'sixty' }))).toBe(lease().holder);
  });

  it('answers no holder where there is none to read', () => {
    expect(leaseHolderOf(null)).toBeNull();
    expect(leaseHolderOf({ holder: 7 })).toBeNull();
    expect(leaseHolderOf('x')).toBeNull();
  });

  it('counts only an unexpired, unstopped, readable lease toward a holder fanout', () => {
    expect(leaseIsUnexpired(lease(), NOW)).toBe(true);
    expect(leaseIsUnexpired(lease({ renewedAt: '2026-09-20T13:00:00.000Z' }), NOW)).toBe(false);
    expect(leaseIsUnexpired(lease({ stopped: '2026-09-20T15:59:00.000Z' }), NOW)).toBe(false);
    expect(leaseIsUnexpired(lease({ minutes: null }), NOW)).toBe(false);
  });
});
