import { say, sayEn } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { describe, expect, it } from 'vitest';
import {
  type CarrierStanding,
  carriersPhrase,
  feedbackStandingOf,
  type PhaseFacts,
  phaseOf,
} from './standing.js';

/** When the times read: a master serves, so no wait here reads stuck by the master alone. */
const AT = {
  since: new Date('2026-10-01T00:00:00Z'),
  master: 'serves' as const,
  now: new Date('2026-10-02T00:00:00Z'),
};
const NO_STANDING_FACTS = { masterOwesTriage: false, carrierRelease: null };

const routedTo = (...statuses: string[]): PhaseFacts => ({
  status: 'triaged',
  route: 'issue',
  routedIssueStatuses: statuses,
  suggestion: null,
  routedRequirementStatus: null,
  routedRequirementDelivered: false,
  rootPhase: null,
});

const reader = {
  isReporter: false,
  canTriage: false,
  canApproveRelease: false,
  canWrite: false,
  canAdmin: false,
};

describe('an issue route carried by several issues reads every one of them (ISS-265)', () => {
  it('is planned while any carrier that is not dropped is still open', () => {
    expect(phaseOf(routedTo('closed', 'in_progress', 'closed'))).toBe('planned');
    expect(phaseOf(routedTo('closed', 'awaiting_release'))).toBe('planned');
  });

  it('is resolved once every carrier that is not dropped is closed', () => {
    expect(phaseOf(routedTo('closed', 'closed', 'closed'))).toBe('resolved');
    expect(phaseOf(routedTo('closed', 'dropped', 'closed'))).toBe('resolved');
  });

  it('reads triaged only when every carrier was dropped, so a person routes it anew', () => {
    expect(phaseOf(routedTo('dropped', 'dropped'))).toBe('triaged');
    expect(phaseOf(routedTo('dropped', 'open'))).toBe('planned');
  });

  it('reads one carrier as before: closed resolves, dropped re-triages, anything else plans', () => {
    expect(phaseOf(routedTo('closed'))).toBe('resolved');
    expect(phaseOf(routedTo('dropped'))).toBe('triaged');
    expect(phaseOf(routedTo('open'))).toBe('planned');
  });

  it('reads an issue route naming no carrier as triaged, never as planned', () => {
    expect(phaseOf(routedTo())).toBe('triaged');
  });
});

describe('a planned item waits on every carrier still owed, each named', () => {
  it('names each key in one phrase', () => {
    const phrase = (keys: string[]) => {
      const said = carriersPhrase(keys);
      return said ? sayEn(said) : null;
    };
    expect(phrase([])).toBeNull();
    expect(phrase(['ISS-1'])).toBe('ISS-1');
    expect(phrase(['ISS-1', 'ISS-2'])).toBe('ISS-1 and ISS-2');
    expect(phrase(['ISS-1', 'ISS-2', 'ISS-3'])).toBe('ISS-1, ISS-2 and ISS-3');
    expect(carriersPhrase(['ISS-1', 'ISS-2'])).toEqual({
      key: 'standing.keysAnd',
      vars: { keys: 'ISS-1', last: 'ISS-2' },
    });
  });

  // REQ-48 BC-9: before the release leg, the item reads its carrier's own wait, never "ship"
  it('waits on what its first carrier waits on, naming it, before every carrier is at the gate', () => {
    const carrier: CarrierStanding = {
      key: 'ISS-4',
      waitingOn: waitingOn('master', {
        who: say('standing.who.master'),
        act: say('issues.standing.act.rerun'),
        rule: say('issues.rule.reopen'),
      }),
      since: AT.since,
      stuck: null,
    };
    const w = feedbackStandingOf(
      'planned',
      'issue',
      ['ISS-4', 'ISS-7'],
      'R',
      reader,
      null,
      { ...NO_STANDING_FACTS, carrier },
      AT,
    ).waitingOn;
    expect(w).toMatchObject({
      kind: 'agent',
      who: 'Master',
      ref: 'ISS-4',
    });
    expect(w.act).toContain('on ISS-4');
    expect(w.rule).toContain('ISS-4 carries it and waits because');
  });

  it('names every carrier at the release gate in the act a writer owes', () => {
    const w = feedbackStandingOf(
      'planned',
      'issue',
      ['ISS-4', 'ISS-7'],
      'R',
      reader,
      null,
      {
        masterOwesTriage: false,
        carrierRelease: 'manual',
        releaseHolders: ['Ada'],
      },
      AT,
    ).waitingOn;
    expect(w.act).toBe('cut the release that carries ISS-4 and ISS-7');
    expect(w.rule).toContain('ISS-4 and ISS-7 wait at awaiting_release');
  });
});
