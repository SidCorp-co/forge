import { describe, expect, it } from 'vitest';
import { foldLanes, medianSeconds } from './pulse-folds.js';

describe('foldLanes', () => {
  it('reads the pipeline lane off issue runs and the scheduler lane off system runs', () => {
    const out = foldLanes([
      { kind: 'issue', failed: 59, total: 4341 },
      { kind: 'system', failed: 35, total: 100 },
    ]);
    expect(out.pipeline).toEqual({ failed: 59, total: 4341 });
    expect(out.scheduler).toEqual({ failed: 35, total: 100 });
    expect(out.other).toEqual({ failed: 0, total: 0 });
  });

  it('keeps a third kind out of both requested lanes', () => {
    const out = foldLanes([
      { kind: 'issue', failed: 1, total: 10 },
      { kind: 'system', failed: 2, total: 20 },
      { kind: 'interactive', failed: 9, total: 9 },
    ]);
    expect(out.pipeline).toEqual({ failed: 1, total: 10 });
    expect(out.scheduler).toEqual({ failed: 2, total: 20 });
    expect(out.other).toEqual({ failed: 9, total: 9 });
  });

  it('sums pm and interactive together under other rather than dropping either', () => {
    const out = foldLanes([
      { kind: 'pm', failed: 1, total: 3 },
      { kind: 'interactive', failed: 2, total: 4 },
    ]);
    expect(out.other).toEqual({ failed: 3, total: 7 });
  });

  it('reports a lane nothing ran in as zero of zero', () => {
    expect(foldLanes([])).toEqual({
      pipeline: { failed: 0, total: 0 },
      scheduler: { failed: 0, total: 0 },
      other: { failed: 0, total: 0 },
    });
  });
});

describe('medianSeconds', () => {
  it('takes the middle of an odd series', () => {
    expect(medianSeconds([30, 10, 20])).toBe(20);
  });

  it('takes the lower of the two middles of an even series', () => {
    expect(medianSeconds([10, 20, 30, 40])).toBe(20);
  });

  it('is null over an empty series rather than zero, which would read as instant', () => {
    expect(medianSeconds([])).toBeNull();
  });
});
