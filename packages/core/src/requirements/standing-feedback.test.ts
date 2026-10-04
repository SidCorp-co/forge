import { describe, expect, it } from 'vitest';
import { base, rev, VIEWER_ONLY } from './standing.fixture.js';
import { deriveStanding } from './standing.js';

describe('feedback about it (ISS-79)', () => {
  const two = { open: 3, untriaged: ['FB-4', 'FB-9'] };

  it('untriaged feedback waits on a signer to triage it, naming each item, and counts into the facts', () => {
    const mine = deriveStanding(base({ feedback: two }));
    expect(mine.attentionGroup).toBe('needs_you');
    expect(mine.waitingOn).toMatchObject({ kind: 'you', act: 'triage 2 feedback items' });
    expect(mine.waitingOn.rule).toContain('FB-4, FB-9');
    expect(mine.facts).toMatchObject({ feedbackOpen: 3, feedbackUntriaged: 2 });
    const theirs = deriveStanding(base({ feedback: two, viewer: VIEWER_ONLY }));
    expect(theirs.attentionGroup).toBe('others');
    expect(theirs.waitingOn).toMatchObject({ kind: 'person', who: 'BA or owner' });
    const one = deriveStanding(base({ feedback: { open: 1, untriaged: ['FB-4'] } }));
    expect(one.waitingOn.act).toBe('triage FB-4');
  });

  it('an accepted requirement is done until feedback about it waits on triage', () => {
    expect(deriveStanding(base({ status: 'accepted' })).attentionGroup).toBe('done');
    const reopened = deriveStanding(base({ status: 'accepted', feedback: two }));
    expect(reopened.attentionGroup).toBe('needs_you');
    expect(reopened.waitingOn.act).toBe('triage 2 feedback items');
  });

  it('a proposed revision outranks feedback; open feedback that is triaged owes nothing here', () => {
    const proposed = deriveStanding(
      base({ feedback: two, revisions: [rev(3, 'proposed'), rev(2, 'current')] }),
    );
    expect(proposed.waitingOn.act).toBe('accept r3');
    const triaged = deriveStanding(base({ feedback: { open: 2, untriaged: [] } }));
    expect(triaged.waitingOn.act).not.toContain('triage');
    expect(triaged.facts).toMatchObject({ feedbackOpen: 2, feedbackUntriaged: 0 });
  });

  it('a dropped or deferred requirement waits on nobody whatever its feedback', () => {
    expect(deriveStanding(base({ status: 'dropped', feedback: two })).waitingOn.kind).toBe('none');
    expect(deriveStanding(base({ status: 'deferred', feedback: two })).waitingOn.kind).toBe('none');
  });
});
