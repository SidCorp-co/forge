import { describe, expect, it } from 'vitest';
import { feedbackStandingOf, revisionStageOf } from './standing.js';

const planned = (stage: Parameters<typeof revisionStageOf>[0]) =>
  feedbackStandingOf('planned', 'revision', null, 'Reporter', false, revisionStageOf(stage))
    .waitingOn;

describe('a revision-routed item waits on whoever owes the next act of its revision', () => {
  it('waits on a person while the proposal is undecided', () => {
    const w = planned({
      status: 'proposed',
      revisionLive: false,
      delivered: false,
      requirement: 'REQ-1',
      revision: null,
    });
    expect(w.kind).toBe('person');
    expect(w.act).toBe('be accepted');
  });

  it('waits on a person to make the accepted revision current', () => {
    const w = planned({
      status: 'accepted',
      revisionLive: false,
      delivered: false,
      requirement: 'REQ-1',
      revision: 2,
    });
    expect(w.kind).toBe('person');
    expect(w.who).toBe('REQ-1 r2');
    expect(w.act).toBe('be made current');
  });

  it('waits on the delivering work, not a person, once the revision is current', () => {
    const w = planned({
      status: 'accepted',
      revisionLive: true,
      delivered: false,
      requirement: 'REQ-1',
      revision: 2,
    });
    expect(w.kind).toBe('issue');
    expect(w.who).toBe('REQ-1 r2');
    expect(w.act).toBe('be delivered');
    expect(w.ref).toBe('REQ-1');
    expect(w.rule).not.toContain('accepted and delivered');
  });

  it('names no stage it cannot read: a revision route with no suggestion read falls back to the proposal', () => {
    expect(revisionStageOf(null)).toBeNull();
    const w = feedbackStandingOf('planned', 'revision', null, 'Reporter', false, null).waitingOn;
    expect(w.kind).toBe('person');
  });
});
