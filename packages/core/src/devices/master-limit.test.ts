import type { MasterLimitRecord } from '@forge/contracts/master-verdict';
import { MASTER_NUDGE_REFRESH_SECONDS } from '@forge/contracts/master-verdict';
import { describe, expect, it } from 'vitest';
import { masterLimitAction, masterRefusalLimit } from './master-limit.js';

const now = new Date('2026-10-07T10:00:00Z');
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
const free = { limitReason: null, limitRefusedAt: null } as const;
const refused = (agoSeconds: number, over: Partial<MasterLimitRecord> = {}): MasterLimitRecord =>
  ({
    kind: 'refused',
    agoSeconds,
    reason: 'usage_limit',
    resetsInSeconds: 3 * 3600,
    detail: "You've hit your limit · resets 2:30am (Asia/Ho_Chi_Minh)",
    ...over,
  }) as MasterLimitRecord;

// ADR 0009: the box read the freshness window and the clear window itself, from a hand copy of
// core's nudge refresh. It sends the record; whether it speaks for the account is decided here.
describe('masterLimitAction: core decides whether a box record is fresh, new and a lifting', () => {
  it('reports a fresh refusal core is not holding, dated by the record and not by its arrival', () => {
    expect(masterLimitAction(refused(30), free, now)).toEqual({
      act: 'report',
      report: {
        reason: 'usage_limit',
        refusedAt: ago(30),
        resetsInSeconds: 3 * 3600,
        detail: "You've hit your limit · resets 2:30am (Asia/Ho_Chi_Minh)",
      },
    });
  });

  it('leaves a refusal whose next try has already come, and one past the freshness window', () => {
    expect(masterLimitAction(refused(MASTER_NUDGE_REFRESH_SECONDS), free, now)).toEqual({
      act: 'none',
      outcome: 'stale',
    });
    expect(masterLimitAction(refused(MASTER_NUDGE_REFRESH_SECONDS - 1), free, now)).toMatchObject({
      act: 'report',
    });
    expect(masterLimitAction(refused(-(20 * 60 + 1)), free, now)).toMatchObject({
      outcome: 'stale',
    });
  });

  it('does not stamp a refusal core already holds again, and does stamp a newer one', () => {
    const held = { limitReason: 'usage_limit', limitRefusedAt: ago(30) } as const;
    expect(masterLimitAction(refused(31), held, now)).toEqual({ act: 'none', outcome: 'held' });
    expect(masterLimitAction(refused(30 + 4 * 60), held, now)).toEqual({
      act: 'none',
      outcome: 'held',
    });
    const older = { limitReason: 'usage_limit', limitRefusedAt: ago(6 * 60) } as const;
    expect(masterLimitAction(refused(5), older, now)).toMatchObject({ act: 'report' });
    const other = { limitReason: 'rate_limit', limitRefusedAt: ago(30) } as const;
    expect(masterLimitAction(refused(30), other, now)).toMatchObject({ act: 'report' });
  });

  it('reports an auth refusal with no reset however the box sent it, inside the freshness window', () => {
    const r = refused(10 * 60, { reason: 'auth', resetsInSeconds: 99 });
    expect(masterLimitAction(r, free, now)).toMatchObject({
      act: 'report',
      report: { reason: 'auth', resetsInSeconds: null },
    });
  });

  it('lifts a held limit only on a turn the account answered within one nudge refresh', () => {
    const held = { ...free, limitReason: 'usage_limit' } as const;
    expect(masterLimitAction({ kind: 'worked', agoSeconds: 299 }, held, now)).toEqual({
      act: 'clear',
    });
    expect(masterLimitAction({ kind: 'worked', agoSeconds: 301 }, held, now)).toMatchObject({
      outcome: 'nothing',
    });
    expect(masterLimitAction({ kind: 'worked', agoSeconds: -1 }, held, now)).toMatchObject({
      outcome: 'nothing',
    });
    expect(masterLimitAction({ kind: 'worked', agoSeconds: 10 }, free, now)).toMatchObject({
      outcome: 'nothing',
    });
  });

  it('names a refusal slug it was not taught', () => {
    expect(masterLimitAction({ kind: 'unreadable', slug: 'new_error' }, free, now)).toEqual({
      act: 'none',
      outcome: 'unreadable',
    });
  });
});

// ISS-276 / FB-87: the account printed 19:30Z and answered at 16:42Z. The printed time is the
// account's claim, kept as that; the runner is held only until the next try, the next nudge.
describe('masterRefusalLimit: a refusal holds until the next nudge, and keeps the printed time as a claim', () => {
  it('holds until refused-at plus the nudge refresh, never until the printed reset', () => {
    const limit = masterRefusalLimit(
      { reason: 'usage_limit', refusedAt: ago(30), resetsInSeconds: 3 * 3600, detail: 'capped' },
      now,
    );
    expect(limit).toEqual({
      reason: 'usage_limit',
      refusedAt: ago(30),
      nextTryAt: new Date(ago(30).getTime() + MASTER_NUDGE_REFRESH_SECONDS * 1000),
      printedResetAt: new Date(now.getTime() + 3 * 3600 * 1000),
      detail: 'capped',
    });
  });

  it('holds a refusal that printed no reset the same way, and records no claim', () => {
    const limit = masterRefusalLimit(
      { reason: 'rate_limit', refusedAt: now, resetsInSeconds: null, detail: 'slow down' },
      now,
    );
    expect(limit.nextTryAt).toEqual(new Date(now.getTime() + MASTER_NUDGE_REFRESH_SECONDS * 1000));
    expect(limit.printedResetAt).toBeNull();
  });

  it('gives an auth refusal no next try and no printed time: a person fixes it', () => {
    const limit = masterRefusalLimit(
      { reason: 'auth', refusedAt: now, resetsInSeconds: 60, detail: 'API Error: 401' },
      now,
    );
    expect(limit).toMatchObject({ nextTryAt: null, printedResetAt: null, refusedAt: now });
  });

  it('dates a refusal the box clock reads ahead no later than now', () => {
    const limit = masterRefusalLimit(
      {
        reason: 'usage_limit',
        refusedAt: new Date(now.getTime() + 90_000),
        resetsInSeconds: null,
        detail: 'x',
      },
      now,
    );
    expect(limit.refusedAt).toEqual(now);
  });
});
