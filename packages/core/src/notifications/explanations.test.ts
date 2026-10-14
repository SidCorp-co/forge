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
