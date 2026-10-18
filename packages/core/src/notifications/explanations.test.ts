import { stuckCountSentence, stuckGroupTitle, stuckRowWords } from '@forge/contracts/stuck-words';
import { describe, expect, it } from 'vitest';
import {
  detectorOfGroupKey,
  explanationOfGroupKey,
  SWEEP_DETECTORS,
  sweepGroup,
  sweepGroupKey,
} from './explanations.js';

const NOW = new Date('2026-10-14T09:30:30.000Z');

describe('the sweep detectors', () => {
  it('give every detector a title and an explanation of its own', () => {
    const entries = Object.values(SWEEP_DETECTORS);
    expect(entries.every((d) => d.groupTitle.length > 0 && d.explanation.length > 0)).toBe(true);
    expect(new Set(entries.map((d) => d.groupTitle)).size).toBe(entries.length);
    expect(new Set(entries.map((d) => d.explanation)).size).toBe(entries.length);
  });

  it('write one key for every pass inside one evaluation minute, and another for the next', () => {
    const same = sweepGroupKey('owed-close', new Date(NOW.getTime() + 20_000));
    expect(same).toBe(sweepGroupKey('owed-close', NOW));
    expect(sweepGroupKey('owed-close', new Date(NOW.getTime() + 60_000))).not.toBe(same);
  });

  it('pair a detector’s key with its own title', () => {
    expect(sweepGroup('stranded', NOW)).toEqual({
      groupKey: sweepGroupKey('stranded', NOW),
      groupTitle: SWEEP_DETECTORS.stranded.groupTitle,
    });
  });
});

describe('reading a group key back', () => {
  it.each(Object.keys(SWEEP_DETECTORS))('names %s from the key it wrote', (id) => {
    const key = sweepGroupKey(id as keyof typeof SWEEP_DETECTORS, NOW);
    expect(detectorOfGroupKey(key)).toBe(id);
    expect(explanationOfGroupKey(key)).toBe(
      SWEEP_DETECTORS[id as keyof typeof SWEEP_DETECTORS].explanation,
    );
  });

  it('names no detector for a key no sweep wrote', () => {
    expect(detectorOfGroupKey(null)).toBeNull();
    expect(detectorOfGroupKey('sweep:nothing-writes-this:29866175')).toBeNull();
    expect(detectorOfGroupKey('sweep:owed-close:soon')).toBeNull();
    expect(detectorOfGroupKey('owed-close:29866175')).toBeNull();
    expect(explanationOfGroupKey('sweep:nothing-writes-this:29866175')).toBeNull();
  });
});

// ISS-1229 r13: a park reads as one state, waiting for the person, in its group as in each notice, and
// no explanation a person reads names a stored field.
describe('the words a person reads on a sweep group', () => {
  it('frames a park as waiting for the person and says what it asks for', () => {
    // A group holds the reader's parks and other people's alike, so it says "you" of none (ISS-1229 r16).
    expect(SWEEP_DETECTORS.stranded.groupTitle).toBe(
      'Issues that have been waiting for a person for over six hours',
    );
    expect(SWEEP_DETECTORS.stranded.explanation).toMatch(/decision/);
    expect(SWEEP_DETECTORS.stranded.explanation).not.toMatch(/nothing coming/);
  });

  it.each(Object.keys(SWEEP_DETECTORS))(
    'explains %s without a stored field or engine word',
    (id) => {
      const { explanation } = SWEEP_DETECTORS[id as keyof typeof SWEEP_DETECTORS];
      expect(explanation).not.toMatch(/`strand`|job pool|\bwake\b/);
      // ISS-1229 r16: no command or code name a person cannot type anywhere, such as `unmark`.
      expect(explanation).not.toMatch(/`/);
    },
  );
});

// ISS-1229 r14, judge-35's failure of 90: the headline said an owed close in other words than the
// bell's group. One sentence per kind now; this fails the moment a surface words a kind its own way.
describe('one sentence per stuck kind, on the bell and the project page alike', () => {
  const ownKindSentence = Object.keys(SWEEP_DETECTORS).filter((id) => id !== 'stranded');

  it.each(ownKindSentence)('titles the %s group with its kind’s sentence', (id) => {
    const { kind, groupTitle } = SWEEP_DETECTORS[id as keyof typeof SWEEP_DETECTORS];
    expect(groupTitle).toBe(stuckGroupTitle(kind));
    const predicate = groupTitle.replace(/^Issues that /, '');
    expect(stuckCountSentence(kind, 2)).toBe(`2 issues ${predicate}.`);
    expect(stuckRowWords(kind).toLowerCase()).toBe(
      stuckCountSentence(kind, 1)
        .replace(/^1 issue /, '')
        .replace(/\.$/, '')
        .toLowerCase(),
    );
  });

  it('titles the waiting group over both of its kinds, and words the reader’s apart from other people’s', () => {
    const { groupTitle } = SWEEP_DETECTORS.stranded;
    expect(groupTitle).toBe(stuckGroupTitle('waiting'));
    expect(groupTitle).toBe(stuckGroupTitle('waiting_on_others'));
    expect(groupTitle).not.toMatch(/\byou\b/);
    expect(stuckCountSentence('waiting', 2)).toBe(
      '2 issues have been waiting for you for over six hours.',
    );
    expect(stuckCountSentence('waiting_on_others', 2)).toBe(
      '2 issues have been waiting for other people for over six hours.',
    );
    expect(stuckRowWords('waiting_on_others', 'Mai')).toBe(
      'Has been waiting for Mai for over six hours',
    );
  });

  it('says an owed close in the bell group’s words on the headline', () => {
    expect(SWEEP_DETECTORS['owed-close'].groupTitle).toBe(
      'Issues that shipped their code and were never closed',
    );
    expect(stuckCountSentence('owed_close', 2)).toBe(
      '2 issues shipped their code and were never closed.',
    );
  });
});
