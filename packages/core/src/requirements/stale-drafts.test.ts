import { DRAFT_STALE_DAYS, isStaleDraftQuestion } from '@forge/contracts/stale-drafts';
import { describe, expect, it } from 'vitest';
import { type DraftFacts, recommendationOf, staleDraftQuestion } from './stale-drafts.js';

// REQ-41 BC-12: the recommended answer a merge-or-drop question carries, read from the product record.

const facts = (over: Partial<DraftFacts> = {}): DraftFacts => ({
  key: 'REQ-7',
  mergeInto: null,
  asks: [],
  ended: null,
  days: 8,
  ...over,
});

describe('recommendationOf', () => {
  it('drops a draft whose requirement ended, before anything else is weighed', () => {
    const r = recommendationOf(
      facts({ ended: { key: 'REQ-3', status: 'accepted' }, mergeInto: 'ISS-9', asks: ['FB-1'] }),
    );
    expect(r).toEqual({
      answer: 'drop',
      why: 'REQ-3, the requirement it delivers, is accepted, so no work waits on this draft.',
    });
  });

  it('merges a draft that reads as a live item, naming it', () => {
    expect(recommendationOf(facts({ mergeInto: 'REQ-2', asks: ['FB-1'] })).answer).toBe('merge');
  });

  it('keeps a draft open feedback still asks for, naming the feedback', () => {
    expect(recommendationOf(facts({ asks: ['FB-4', 'FB-5'] }))).toEqual({
      answer: 'keep',
      why: 'open feedback still asks for it: FB-4, FB-5.',
    });
  });

  it('drops a draft nothing asks for, saying for how long nobody touched it', () => {
    expect(recommendationOf(facts()).why).toBe(
      'nobody touched it for 8 days, and no open feedback or live item asks for it.',
    );
  });
});

describe('staleDraftQuestion', () => {
  it('offers merge, drop and keep, recommends one of them, and carries the mark the needs-me read files it by', () => {
    const q = staleDraftQuestion(
      { key: 'REQ-7', title: 'Export to CSV', what: 'a draft requirement' },
      facts({ mergeInto: 'REQ-2' }),
    );
    expect(q.options.map((o) => o.label)).toEqual([
      'Merge into REQ-2',
      'Drop it',
      'Keep it as a draft',
    ]);
    expect(q.recommendedOptionId).toBe('stale_draft.merge');
    expect(q.options.some((o) => o.id === q.recommendedOptionId)).toBe(true);
    expect(isStaleDraftQuestion(q.options)).toBe(true);
    expect(q.prompt).toContain(
      'Recommended: Merge into REQ-2, because it reads as the same as REQ-2',
    );
    expect(DRAFT_STALE_DAYS).toBe(7);
  });
});
