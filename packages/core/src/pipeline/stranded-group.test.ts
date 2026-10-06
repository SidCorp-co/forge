import { describe, expect, it } from 'vitest';
import { sweepGroupKey } from './stranded-issues.js';

// F10: a project's strands of one kind reach the bell as one row, however many sweeps found them
describe('the bell row a stranded notice joins', () => {
  it('is the same for every sweep that finds a strand of that kind in that project', () => {
    expect(sweepGroupKey('owed-close', 'p1')).toBe(sweepGroupKey('owed-close', 'p1'));
    expect(sweepGroupKey('owed-close', 'p1')).not.toMatch(/:\d{8,}$/);
  });

  it('is separate per project and per kind of strand', () => {
    expect(sweepGroupKey('owed-close', 'p1')).not.toBe(sweepGroupKey('owed-close', 'p2'));
    expect(sweepGroupKey('owed-close', 'p1')).not.toBe(sweepGroupKey('stranded', 'p1'));
  });
});
