// REQ-48 BC-11: Needs you shows at most three decisions a person owes at a time, the ones holding
// a stuck item first, and counts the rest as "+n more", never dropping one.

import type { NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import { NEEDS_YOU_PERSON_CAP } from '@forge/contracts/steward';
import { describe, expect, it } from 'vitest';
import { needsYouOf } from './lead.js';

const decision = (key: string, over: Partial<NeedsYouDecision> = {}): NeedsYouDecision => ({
  group: 'approve',
  area: 'requirements',
  entity: 'requirement',
  key,
  title: key,
  opens: { kind: 'requirement', key },
  question: `Agree ${key}?`,
  recommended: { answerId: 'agree', why: 'rule', by: 'rule' },
  noRecommendation: null,
  answers: [
    {
      id: 'agree',
      label: `Agree ${key}`,
      act: 'requirement.agree',
      path: `/api/projects/p/requirements/${key}/agree`,
      body: {},
      needsReason: false,
      effect: null,
      recommended: true,
    },
  ],
  touchedAt: '2026-10-01T00:00:00.000Z',
  stuck: false,
  dueAt: null,
  id: `row:${key}`,
  topic: 'requirement',
  proposal: null,
  ...over,
});

describe('Needs you, capped', () => {
  const five = [
    decision('REQ-1'),
    decision('REQ-2', { dueAt: '2026-10-22T00:00:00.000Z' }),
    decision('REQ-3'),
    decision('REQ-4', { stuck: true }),
    decision('REQ-5', { dueAt: '2026-10-20T00:00:00.000Z' }),
  ];
  const read = needsYouOf(five, 'forge-dev', '2026-10-21T09:00:00.000Z');

  it('shows three, and counts the other two as more, never dropping them', () => {
    expect(NEEDS_YOU_PERSON_CAP).toBe(3);
    expect(read.decisions).toHaveLength(3);
    expect(read.more).toBe(2);
    expect(read.total).toBe(5);
  });

  it('leads with the decision holding a stuck item, then the soonest due', () => {
    expect(read.decisions.map((d) => d.key)).toEqual(['REQ-4', 'REQ-5', 'REQ-2']);
  });

  it('carries the recommended answer and where the item opens', () => {
    expect(read.decisions[0]).toMatchObject({
      recommended: 'Agree REQ-4',
      href: '/projects/forge-dev/requirements/REQ-4',
    });
  });

  it('says no more where three or fewer are owed', () => {
    expect(needsYouOf(five.slice(0, 2), 'forge-dev', '2026-10-21T09:00:00.000Z').more).toBe(0);
  });
});
