import type { MasterLimitRecord } from '@forge/contracts/master-verdict';
import { describe, expect, it } from 'vitest';
import { masterLimitAction } from './master-limit.js';

const now = new Date('2026-10-07T10:00:00Z');
const free = { limitReason: null, limitDetail: null, rateLimitedUntil: null } as const;
const refused = (agoSeconds: number, over: Partial<MasterLimitRecord> = {}): MasterLimitRecord =>
  ({
    kind: 'refused',
    agoSeconds,
    reason: 'usage_limit',
    resetsInSeconds: 3600,
    detail: "You've hit your limit",
    ...over,
  }) as MasterLimitRecord;

// ADR 0009: the box read the freshness window and the clear window itself, from a hand copy of
// core's nudge refresh. It sends the record; whether it speaks for the account is decided here.
describe('masterLimitAction: core decides whether a box record is fresh, new and a lifting', () => {
  it('reports a fresh refusal core is not holding, with its reset', () => {
    expect(masterLimitAction(refused(30), free, now)).toEqual({
      act: 'report',
      report: { reason: 'usage_limit', resetsInSeconds: 3600, detail: "You've hit your limit" },
    });
  });

  it('leaves a refusal older than the freshness window alone, either way round', () => {
    expect(masterLimitAction(refused(20 * 60 + 1), free, now)).toEqual({
      act: 'none',
      outcome: 'stale',
    });
    expect(masterLimitAction(refused(-(20 * 60 + 1)), free, now)).toMatchObject({
      outcome: 'stale',
    });
    expect(masterLimitAction(refused(20 * 60), free, now)).toMatchObject({ act: 'report' });
  });

  it('does not stamp a refusal core already holds again', () => {
    const held = {
      limitReason: 'usage_limit',
      limitDetail: "You've hit your limit",
      rateLimitedUntil: new Date(now.getTime() + 60_000),
    } as const;
    expect(masterLimitAction(refused(30), held, now)).toEqual({ act: 'none', outcome: 'held' });
    const lapsed = { ...held, rateLimitedUntil: new Date(now.getTime() - 1) };
    expect(masterLimitAction(refused(30), lapsed, now)).toMatchObject({ act: 'report' });
    const other = { ...held, limitDetail: 'a different wording' };
    expect(masterLimitAction(refused(30), other, now)).toMatchObject({ act: 'report' });
  });

  it('reports an auth refusal with no reset however the box sent it', () => {
    const r = refused(5, { reason: 'auth', resetsInSeconds: 99 });
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
