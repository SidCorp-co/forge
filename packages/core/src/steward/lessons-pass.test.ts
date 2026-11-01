// ISS-867 (REQ-50 r2 BC-2): why 193 corrections gave no lesson, each cause pinned. The grouping's
// answer must be readable when the model leaves out what it has nothing to say about, its budget must
// hold an answer over the whole window, and its prompt must name every field the answer is read by.

import { LESSON_ITEM_KINDS } from '@forge/contracts/lessons';
import { describe, expect, it } from 'vitest';

const { GATHER_CORRECTIONS } = await import('../lessons/index.js');
const { GROUP_REASON_CHARS, groupingBudget, groupingPrompt, groupingSchema } = await import(
  './lessons-pass.js'
);

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

describe('the grouping answer is read, not dropped (ISS-867)', () => {
  it('reads an answer that leaves out an empty list and the null keys of a proposal', () => {
    const parsed = groupingSchema.safeParse({
      proposals: [
        {
          sentence: 'Name the unit beside every number.',
          scope: 'project',
          corrections: [uuid(1), uuid(2)],
        },
      ],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toEqual({
      rejections: [],
      links: [],
      proposals: [
        {
          sentence: 'Name the unit beside every number.',
          scope: 'project',
          corrections: [uuid(1), uuid(2)],
        },
      ],
    });
  });

  it('reads an answer with nothing to say as empty lists', () => {
    expect(groupingSchema.parse({})).toEqual({ rejections: [], links: [], proposals: [] });
  });

  it('still refuses an answer whose proposal says no sentence or an unknown scope (negative)', () => {
    const bad = (p: object) =>
      groupingSchema.safeParse({ proposals: [{ corrections: [uuid(1), uuid(2)], ...p }] }).success;
    expect(bad({ scope: 'project' })).toBe(false);
    expect(bad({ sentence: 'x', scope: 'everywhere' })).toBe(false);
    expect(bad({ sentence: 'x', scope: 'project', itemKind: 'ticket' })).toBe(false);
  });
});

describe('the grouping budget holds an answer over the whole window (ISS-867)', () => {
  // a token is at least three characters of this JSON (uuids and English); a fixed 1500 tokens held
  // about twenty rejections, so a window of sixty truncated, and a truncated answer parses as nothing
  const tokensOf = (answer: object) => Math.ceil(JSON.stringify(answer).length / 3);

  it('fits every correction in the window rejected with the longest reason asked for', () => {
    const reason = 'r'.repeat(GROUP_REASON_CHARS);
    const answer = {
      rejections: Array.from({ length: GATHER_CORRECTIONS }, (_, i) => ({
        correction: uuid(i),
        reason,
      })),
      links: [],
      proposals: [],
    };
    expect(tokensOf(answer)).toBeLessThanOrEqual(groupingBudget(GATHER_CORRECTIONS));
  });

  it('fits the window grouped in pairs, each with a full sentence', () => {
    const answer = {
      rejections: [],
      links: [],
      proposals: Array.from({ length: GATHER_CORRECTIONS / 2 }, (_, i) => ({
        sentence: 's'.repeat(240),
        scope: 'item_kind',
        areaId: null,
        itemKind: 'requirement',
        corrections: [uuid(2 * i), uuid(2 * i + 1)],
        supersedes: null,
      })),
    };
    expect(tokensOf(answer)).toBeLessThanOrEqual(groupingBudget(GATHER_CORRECTIONS));
  });

  it('grows with the corrections read, so a small pass asks for less (boundary)', () => {
    expect(groupingBudget(1)).toBeLessThan(groupingBudget(GATHER_CORRECTIONS));
  });
});

describe('the grouping prompt names every field its answer is read by (ISS-867)', () => {
  it('names each list and each field inside them', () => {
    const prompt = groupingPrompt({
      corrections: [
        {
          id: uuid(1),
          source: 'verdict_failed',
          itemKind: 'issue',
          itemKey: 'ISS-1',
          areaId: null,
          reason: 'The page showed a raw id.',
        },
      ],
      lessons: [],
    });
    for (const field of [
      'rejections',
      'correction',
      'reason',
      'links',
      'lesson',
      'proposals',
      'sentence',
      'corrections',
      'scope',
      'areaId',
      'itemKind',
      'supersedes',
    ]) {
      expect(prompt, field).toContain(`\`${field}\``);
    }
    for (const kind of LESSON_ITEM_KINDS) expect(prompt).toContain(kind);
  });
});
