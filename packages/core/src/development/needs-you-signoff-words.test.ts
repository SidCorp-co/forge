// ISS-645 r2 (REQ-4 BC-16, judge K144 on 0.4.0-dev.355): a sign-off's one press records the words of
// the revision it signs, never one instruction sentence said alike on every accept; a revision that
// gives no words of its own recommends nothing, so its press asks the signer for theirs.
// @direct-test-of packages/core/src/development/needs-you-signoff-words.ts
// @direct-test-of packages/core/src/development/needs-you-approve-builders.ts

import { needsYouDecisionSchema } from '@forge/contracts/needs-you-decisions';
import { describe, expect, it } from 'vitest';
import type { AttentionRow } from './needs-you.js';
import { agreeDecision, revisionDecision } from './needs-you-approve-builders.js';
import { type Built, prefilledReason } from './needs-you-decision-builders.js';
import { revisionWords } from './needs-you-signoff-words.js';

const P = '6f0ee160-8432-4b84-98cf-956b6cd65a29';
const row = {
  entity: 'requirement',
  key: 'REQ-1',
  title: 'REQ-1',
  touchedAt: '2026-10-29T07:00:00.000Z',
} as unknown as AttentionRow;

/** The decision as the read serves it: the reason prefilled, then parsed by the contract. */
const served = (b: Built) =>
  needsYouDecisionSchema.parse({
    id: 'x',
    stuck: false,
    dueAt: null,
    topic: 'requirement',
    proposal: null,
    ...prefilledReason(b.decision),
  });

describe('revisionWords', () => {
  it('is the change summary then the author’s reason', () => {
    expect(revisionWords({ changeSummary: 'Adds BC-2', reason: 'The ward asked' })).toBe(
      'Adds BC-2 — The ward asked',
    );
  });

  it('says a part once where both are the same, and keeps whichever one is given', () => {
    expect(revisionWords({ changeSummary: 'Adds BC-2', reason: ' Adds BC-2 ' })).toBe('Adds BC-2');
    expect(revisionWords({ changeSummary: null, reason: 'The ward asked' })).toBe('The ward asked');
    expect(revisionWords({ changeSummary: 'Adds BC-2', reason: null })).toBe('Adds BC-2');
  });

  it('is null where the revision gives no visible words', () => {
    expect(revisionWords({ changeSummary: null, reason: null })).toBeNull();
    expect(
      revisionWords({ changeSummary: '  ', reason: String.fromCodePoint(0x200b, 0x2060) }),
    ).toBeNull();
  });

  it('fits a decision’s why, cut at a word', () => {
    const long = revisionWords({ changeSummary: 'word '.repeat(200), reason: null }) ?? '';
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.endsWith('word…')).toBe(true);
  });
});

describe('a sign-off decision', () => {
  it('recommends the accept with the revision’s words, which its press sends as the reason', () => {
    const d = served(revisionDecision(row, 'requirements', P, 2, 'Adds BC-2 — The ward asked'));
    expect(d.recommended).toEqual({
      answerId: 'accept',
      why: 'Adds BC-2 — The ward asked',
      by: 'rule',
    });
    expect(d.answers[0]?.body).toEqual({ reason: 'Adds BC-2 — The ward asked' });
  });

  it('recommends nothing for a revision with no words, and its accept asks for the signer’s', () => {
    const d = served(revisionDecision(row, 'requirements', P, 2, null));
    expect(d.recommended).toBeNull();
    expect(d.noRecommendation).toBe('Revision 2 says neither what it changes nor why.');
    expect(d.answers[0]).toMatchObject({ id: 'accept', needsReason: true, recommended: false });
    expect(d.answers[0]?.body).toEqual({});
  });

  it('holds the agree to the same rule', () => {
    const said = served(agreeDecision(row, 'requirements', P, 3, 'Restores BC-3'));
    expect(said.answers[0]).toMatchObject({
      id: 'agree',
      body: { revision: 3, reason: 'Restores BC-3' },
    });
    const bare = served(agreeDecision(row, 'requirements', P, 3, null));
    expect(bare.recommended).toBeNull();
    expect(bare.answers[0]).toMatchObject({
      id: 'agree',
      body: { revision: 3 },
      recommended: false,
    });
  });
});
