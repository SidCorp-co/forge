import { describe, expect, it } from 'vitest';
import type { LeaseReading, LeaseVerdict } from './session-claim.js';
import {
  classifyLease,
  leaseHolderOf,
  leaseIsReleasable,
  leaseIsUnexpired,
  leaseIsWorkInProgress,
  leaseShowsHolderGone,
  leaseSilenceToleranceMs,
  MIN_SILENCE_MS,
  MISSED_BEATS,
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
    for (const v of ['none', 'shared', 'expired', 'abandoned', 'malformed'] as const) {
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
      silentMs: null,
      detail: '',
    });
    expect(leaseIsReleasable(at('expired'))).toBe(true);
    expect(leaseIsReleasable(at('abandoned'))).toBe(true);
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

/**
 * ISS-1195 — the wall clock cannot represent a holder that died inside its own term, so a lease it
 * reads `live` is no evidence at all about the process behind it. The heartbeat is the holder's own
 * promise to report, and it is the only thing here core may hold a holder to: a run that declared
 * no period promised nothing, and every verdict over it is what it was before this existed.
 */
describe('a holder that declared a heartbeat (ISS-1195)', () => {
  const beat = (over: Record<string, unknown> = {}) => ({
    at: '2026-09-20T15:45:00.000Z',
    everySeconds: 60,
    ...over,
  });
  const read = (heartbeat: unknown, over: Record<string, unknown> = {}, fanout = 1) =>
    classifyLease({ lease: lease({ heartbeat, ...over }), now: NOW, fanout });

  it('reads a holder silent past its own tolerance as `abandoned`, and says for how long', () => {
    const it = read(beat({ at: '2026-09-20T15:40:00.000Z' }));
    expect(it.verdict).toBe('abandoned');
    expect(it.silentMs).toBe(20 * 60_000);
    expect(leaseIsWorkInProgress(it.verdict)).toBe(false);
    expect(leaseIsReleasable(it)).toBe(true);
    expect(leaseShowsHolderGone(it.verdict)).toBe(true);
  });

  it.each([[undefined], [null]])(
    'leaves a lease declaring no heartbeat (%s) reading exactly as the wall clock reads it',
    (absent) => {
      expect(read(absent).verdict).toBe('live');
      expect(read(absent).silentMs).toBeNull();
      expect(read(absent, {}, 3).verdict).toBe('shared');
      expect(read(absent, { renewedAt: '2026-09-20T13:23:00.000Z' }).verdict).toBe('expired');
      expect(read(absent, { stopped: '2026-09-20T15:50:00.000Z' }).verdict).toBe('expired');
    },
  );

  it('leaves a holder reporting inside its tolerance reading `live`', () => {
    expect(read(beat({ at: '2026-09-20T15:59:00.000Z' })).verdict).toBe('live');
  });

  /** The boundary itself: at the tolerance the holder has missed its beats and no more. */
  it('does not call silence equal to the tolerance absence', () => {
    const tolerance = leaseSilenceToleranceMs(60);
    expect(tolerance).toBe(MISSED_BEATS * 60_000);
    const at = (silentMs: number) =>
      read(beat({ at: new Date(NOW.getTime() - silentMs).toISOString() })).verdict;
    expect(at(tolerance)).toBe('live');
    expect(at(tolerance + 1)).toBe('abandoned');
  });

  it('floors the tolerance, so a holder declaring seconds does not flap on jitter', () => {
    expect(leaseSilenceToleranceMs(1)).toBe(MIN_SILENCE_MS);
    expect(leaseSilenceToleranceMs(3600)).toBe(3600 * 1000 * MISSED_BEATS);
    expect(read(beat({ everySeconds: 1, at: '2026-09-20T15:59:30.000Z' })).verdict).toBe('live');
  });

  /**
   * A heartbeat is a direct measurement of the holder and a fanout is an inference from a pattern
   * of rows, so a wave id that has gone silent is every one of its rows abandoned rather than every
   * one of them an observation that decides nothing — `shared` is never released.
   */
  it('outranks the fanout, so a silent holder on many rows is abandoned on each', () => {
    expect(read(beat({ at: '2026-09-20T15:40:00.000Z' }), {}, 5).verdict).toBe('abandoned');
  });

  /** A holder writing a bad heartbeat must not be able to make every lapsed claim unreleasable. */
  it.each([
    ['stopped', { stopped: '2026-09-20T15:50:00.000Z' }],
    ['expired', { renewedAt: '2026-09-20T13:23:00.000Z' }],
  ])('lets a %s lease go on being released though its heartbeat is unreadable', (_n, over) => {
    const it = read({ at: 'whenever' }, over);
    expect(it.verdict).toBe('expired');
  });

  it.each([
    ['at missing', beat({ at: undefined }), 'heartbeat.at'],
    ['at not a timestamp', beat({ at: 'whenever' }), 'heartbeat.at'],
    ['at not a string', beat({ at: 1758384000000 }), 'heartbeat.at'],
    ['everySeconds not a number', beat({ everySeconds: '60' }), 'heartbeat.everySeconds'],
    ['everySeconds not positive', beat({ everySeconds: 0 }), 'heartbeat.everySeconds'],
    ['everySeconds not finite', beat({ everySeconds: Number.POSITIVE_INFINITY }), 'everySeconds'],
    ['heartbeat a string', 'beating', 'heartbeat is string'],
    ['heartbeat an array', [beat()], 'heartbeat is an array'],
  ])('reads a lease whose %s as `malformed`, naming the field', (_name, value, names) => {
    const it = read(value);
    expect(it.verdict).toBe('malformed');
    expect(it.detail).toContain(names);
    expect(leaseIsReleasable(it)).toBe(false);
  });

  /**
   * A beat stamped ahead of this reader is a clock the two ends do not share. Absorbed, it would
   * read as a fresh beat for as long as the gap lasted — the failure this whole reading exists to
   * refuse, arriving by the field meant to close it.
   */
  it('tolerates a beat a little ahead of the reader and refuses one far ahead', () => {
    expect(read(beat({ at: '2026-09-20T16:00:30.000Z' })).verdict).toBe('live');
    expect(read(beat({ at: '2026-09-20T16:00:30.000Z' })).silentMs).toBe(0);
    const far = read(beat({ at: '2026-09-20T16:10:00.000Z' }));
    expect(far.verdict).toBe('malformed');
    expect(far.detail).toContain('ahead of this reader');
  });

  /**
   * The plan consult's F4. Were an unreadable heartbeat to answer this, a lease carrying NO
   * heartbeat would drop out of its holder's fanout because a sibling row is malformed, and change
   * verdict — an absent-heartbeat lease behaving differently, which is the one thing this reading
   * promised never to do.
   */
  it('keeps the fanout predicate on the base fields, whatever the heartbeat says', () => {
    expect(leaseIsUnexpired(lease({ heartbeat: { at: 'whenever' } }), NOW)).toBe(true);
    expect(
      leaseIsUnexpired(lease({ heartbeat: beat({ at: '2026-09-20T15:40:00.000Z' }) }), NOW),
    ).toBe(true);
  });

  it('shows no other verdict as evidence the holder is gone', () => {
    for (const v of ['none', 'live', 'shared', 'expired', 'malformed'] as const) {
      expect(leaseShowsHolderGone(v)).toBe(false);
    }
  });
});
