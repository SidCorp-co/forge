import { describe, expect, it } from 'vitest';
import { computeSkillDiff } from './sync.js';

const manifest = (name: string, hash: string, overrides: Record<string, unknown> = {}) => ({
  name,
  prompt: 'body',
  tools: [],
  hash,
  ...overrides,
});

describe('computeSkillDiff', () => {
  it('classifies new skills as toInsert', () => {
    const diff = computeSkillDiff([], [manifest('a', 'h1'), manifest('b', 'h2')]);
    expect(diff.toInsert.map((s) => s.name)).toEqual(['a', 'b']);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.toRemove).toHaveLength(0);
  });

  it('classifies matching hash as unchanged', () => {
    const diff = computeSkillDiff([{ name: 'a', contentHash: 'h1' }], [manifest('a', 'h1')]);
    expect(diff.unchanged).toEqual(['a']);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it('classifies hash drift as toUpdate', () => {
    const diff = computeSkillDiff([{ name: 'a', contentHash: 'old' }], [manifest('a', 'new')]);
    expect(diff.toUpdate.map((s) => s.name)).toEqual(['a']);
    expect(diff.unchanged).toHaveLength(0);
  });

  it('partial mode leaves extras alone', () => {
    const diff = computeSkillDiff(
      [
        { name: 'a', contentHash: 'h1' },
        { name: 'b', contentHash: 'h2' },
      ],
      [manifest('a', 'h1')],
      'partial',
    );
    expect(diff.unchanged).toEqual(['a']);
    expect(diff.toRemove).toEqual([]);
  });

  it('full mode removes existing rows missing from incoming', () => {
    const diff = computeSkillDiff(
      [
        { name: 'a', contentHash: 'h1' },
        { name: 'b', contentHash: 'h2' },
      ],
      [manifest('a', 'h1')],
      'full',
    );
    expect(diff.toRemove).toEqual(['b']);
    expect(diff.unchanged).toEqual(['a']);
  });

  it('handles empty incoming with full mode (removes everything)', () => {
    const diff = computeSkillDiff([{ name: 'a', contentHash: 'h1' }], [], 'full');
    expect(diff.toRemove).toEqual(['a']);
  });

  it('handles empty existing and empty incoming', () => {
    const diff = computeSkillDiff([], []);
    expect(diff.toInsert).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.toRemove).toHaveLength(0);
  });
});
