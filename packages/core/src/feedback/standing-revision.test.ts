import { describe, expect, it } from 'vitest';
import { feedbackStandingOf, revisionStageOf, type StandingViewer } from './standing.js';

const reader: StandingViewer = {
  isReporter: false,
  canTriage: false,
  canApproveRelease: false,
  canWrite: false,
  canAdmin: false,
};

const planned = (stage: Parameters<typeof revisionStageOf>[0]) =>
  feedbackStandingOf('planned', 'revision', [], 'Reporter', reader, revisionStageOf(stage))
    .waitingOn;

describe('a revision-routed item waits on whoever owes the next act of its revision', () => {
  it('waits on a person while the proposal is undecided', () => {
    const w = planned({
      status: 'proposed',
      revisionState: null,
      delivered: false,
      requirement: 'REQ-1',
      revision: null,
    });
    expect(w.kind).toBe('person');
    expect(w.act).toBe('be accepted');
  });

  it('names the accept of the proposed revision the suggestion accept wrote as the act owed', () => {
    const w = planned({
      status: 'accepted',
      revisionState: 'proposed',
      delivered: false,
      requirement: 'REQ-1',
      revision: 2,
    });
    expect(w.kind).toBe('person');
    expect(w.who).toBe('BA or owner');
    expect(w.act).toBe('accept revision 2 of REQ-1');
    expect(w.ref).toBe('REQ-1');
  });

  it('names its author proposing a revision a signer returned to draft', () => {
    const w = planned({
      status: 'accepted',
      revisionState: 'draft',
      delivered: false,
      requirement: 'REQ-1',
      revision: 2,
    });
    expect(w.kind).toBe('person');
    expect(w.act).toBe('propose revision 2 of REQ-1');
  });

  it('waits on the delivering work, not a person, once the revision is current', () => {
    const w = planned({
      status: 'accepted',
      revisionState: 'current',
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
    const w = feedbackStandingOf('planned', 'revision', [], 'Reporter', reader, null).waitingOn;
    expect(w.kind).toBe('person');
  });
});
