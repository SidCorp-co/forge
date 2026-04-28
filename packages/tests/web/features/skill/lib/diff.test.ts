import { describe, it, expect } from 'vitest';
import { lineDiff } from '@/features/skill/lib/diff';

describe('lineDiff', () => {
  it('returns all-eq when inputs are identical', () => {
    const ops = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(ops).toHaveLength(3);
    expect(ops.every((o) => o.kind === 'eq')).toBe(true);
  });

  it('emits del for removed lines', () => {
    const ops = lineDiff('a\nb\nc', 'a\nc');
    const dels = ops.filter((o) => o.kind === 'del');
    expect(dels).toHaveLength(1);
    expect(dels[0].text).toBe('b');
  });

  it('emits add for inserted lines', () => {
    const ops = lineDiff('a\nc', 'a\nb\nc');
    const adds = ops.filter((o) => o.kind === 'add');
    expect(adds).toHaveLength(1);
    expect(adds[0].text).toBe('b');
  });

  it('handles complete replacement', () => {
    const ops = lineDiff('foo\nbar', 'baz\nqux');
    const adds = ops.filter((o) => o.kind === 'add');
    const dels = ops.filter((o) => o.kind === 'del');
    expect(adds.length).toBe(2);
    expect(dels.length).toBe(2);
  });

  it('handles empty inputs', () => {
    expect(lineDiff('', '')).toEqual([{ kind: 'eq', text: '' }]);
    const ops = lineDiff('', 'hello');
    expect(ops.some((o) => o.kind === 'add' && o.text === 'hello')).toBe(true);
  });
});
