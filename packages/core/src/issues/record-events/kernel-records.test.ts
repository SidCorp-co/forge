import { describe, expect, it } from 'vitest';
import { type MoveRecord, parkRecordFields, transitionRecordFields } from './kernel-records.js';

const move = (over: Partial<MoveRecord> = {}): MoveRecord => ({
  issueId: 'i-1',
  actor: { type: 'user', id: 'u-1', agency: 'human' },
  from: 'in_progress',
  to: 'needs_info',
  requested: 'needs_info',
  reopenCount: 0,
  step: 'build',
  reason: 'which tenant?',
  recovery: false,
  leftStatus: 'in_progress',
  waitingKind: 'needs_answer',
  needs: null,
  ...over,
});

const asMap = (fields: Array<{ key: string; value: string }>) =>
  Object.fromEntries(fields.map((f) => [f.key, f.value]));

describe('the records a move leaves', () => {
  it('a transition names the move, the count after it, its step and its reason', () => {
    expect(asMap(transitionRecordFields(move()))).toEqual({
      from: 'in_progress',
      to: 'needs_info',
      'reopen-count': '0',
      step: 'build',
      reason: 'which tenant?',
    });
  });

  it('names the status asked for where the release gate landed the move elsewhere, and a recovery', () => {
    const held = transitionRecordFields(
      move({
        to: 'awaiting_release',
        requested: 'closed',
        step: null,
        reason: null,
        recovery: true,
      }),
    );
    expect(asMap(held)).toEqual({
      from: 'in_progress',
      to: 'awaiting_release',
      requested: 'closed',
      'reopen-count': '0',
      recovery: 'true',
    });
  });

  it('a needs_info park carries its kind, its question and where it returns', () => {
    expect(asMap(parkRecordFields(move({ needs: 'the tenant id' })))).toEqual({
      status: 'needs_info',
      kind: 'needs_answer',
      why: 'which tenant?',
      'left-status': 'in_progress',
      needs: 'the tenant id',
    });
  });

  it('an on_hold park carries no waiting kind', () => {
    const held = parkRecordFields(
      move({ to: 'on_hold', waitingKind: null, reason: 'paused for the freeze' }),
    );
    expect(asMap(held)).toEqual({
      status: 'on_hold',
      why: 'paused for the freeze',
      'left-status': 'in_progress',
    });
  });
});
