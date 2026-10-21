// REQ-48 BC-9 (docs/proposals/steward-agent.md, "Roll-up", issue → feedback). On dev, 2026-10-21,
// FB-74 was routed to the draft ISS-284 and read four ways: phase Planned, banner "ISS-284: ship",
// body "You to take on or drop", Dashboard "Waiting on a person". Nothing takes a draft on by
// itself, so the item stays triaged and reads stuck, waiting on someone to take the draft on; the
// banner, the body (`forecast/feedback-progress.ts:estimateOf`) and the Dashboard all read this one
// standing.

import { describe, expect, it } from 'vitest';
import { feedbackStandingOf, type PhaseFacts, phaseOf } from './standing.js';

const AT = {
  since: new Date('2026-10-09T08:00:00Z'),
  master: 'serves' as const,
  now: new Date('2026-10-21T09:00:00Z'),
};
const reader = {
  isReporter: false,
  canTriage: true,
  canApproveRelease: false,
  canWrite: true,
  canAdmin: false,
};
const routedTo = (...statuses: string[]): PhaseFacts => ({
  status: 'triaged',
  route: 'issue',
  routedIssueStatuses: statuses,
  suggestion: null,
  routedRequirementStatus: null,
  routedRequirementDelivered: false,
  rootPhase: null,
});

describe("FB-74's shape: feedback routed to a draft issue", () => {
  it('stays triaged, never planned, while a carrier is a draft', () => {
    expect(phaseOf(routedTo('draft'))).toBe('triaged');
    expect(phaseOf(routedTo('draft', 'open'))).toBe('triaged');
    expect(phaseOf(routedTo('open'))).toBe('planned');
  });

  const s = feedbackStandingOf(
    'triaged',
    'issue',
    ['ISS-284'],
    'Reporter',
    reader,
    null,
    { masterOwesTriage: false, carrierRelease: null, draftCarrier: 'ISS-284' },
    AT,
  );

  it('reads stuck draft_carrier through ISS-284, never "ship", never a person to triage', () => {
    expect(s.attentionGroup).toBe('stuck');
    expect(s.times.stuck).toMatchObject({ code: 'draft_carrier', via: 'ISS-284' });
    expect(s.times.stuck?.reason).toBe(
      'ISS-284 is a draft, and nothing takes a draft on by itself.',
    );
    expect(s.waitingOn).toMatchObject({ who: 'Someone', act: 'take on ISS-284', ref: 'ISS-284' });
    expect(s.waitingOn.act).not.toBe('ship');
  });

  it('is in nobody’s Needs you: the steward takes it on, or asks', () => {
    expect(s.attentionGroup).not.toBe('needs_you');
    expect(s.waitingOn.kind).toBe('person');
  });
});

describe('a declined item (FB-89)', () => {
  it('is done and never stuck or due, whatever its kept route carries', () => {
    const s = feedbackStandingOf(
      'declined',
      'issue',
      ['ISS-9'],
      'Reporter',
      reader,
      null,
      { masterOwesTriage: false, carrierRelease: null },
      AT,
    );
    expect(s.attentionGroup).toBe('done');
    expect(s.times.stuck).toBeNull();
    expect(s.times.dueAt).toBeNull();
  });
});
