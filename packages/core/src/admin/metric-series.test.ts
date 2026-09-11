import { describe, expect, it, vi } from 'vitest';

// cm:why metric-series.ts imports db/client.js at module scope, which validates env at import time; stub it so this pure-function suite doesn't need real env/Postgres (integration coverage: tests/integration/admin-metric-series-routes.test.ts)
vi.mock('../db/client.js', () => ({ db: {} }));

const { WINDOW_SPECS, bucketBoundaries, computeSeries, deltaPct, toGlance } = await import(
  './metric-series.js'
);

const NOW = new Date('2026-09-11T12:34:56.000Z');
const SPEC = WINDOW_SPECS['24h'];

/** The 48 hourly bucket starts `computeSeries` lays for the 24h window: the
 *  first 24 are the baseline, the last 24 the current window. */
const boundaries = () => bucketBoundaries(SPEC.unit, SPEC.bucketCount * 2, NOW);

const mapAt = (entries: Array<[number, number]>): Map<string, number> => {
  const b = boundaries();
  const m = new Map<string, number>();
  for (const [index, value] of entries) m.set(b[index] as string, value);
  return m;
};

describe('computeSeries — a plain count', () => {
  const countInput = (entries: Array<[number, number]>) => ({
    num: mapAt(entries),
    den: null,
    scale: 1,
  });

  it('lays one dense point per bucket across both windows, oldest first', () => {
    const series = computeSeries(countInput([[47, 3]]), SPEC, NOW);

    expect(series.points).toHaveLength(48);
    const starts = series.points.map((p) => p.bucketStart);
    expect(starts).toEqual([...starts].sort());
    for (let i = 1; i < starts.length; i++) {
      const step = Date.parse(starts[i] as string) - Date.parse(starts[i - 1] as string);
      expect(step).toBe(3_600_000);
    }
  });

  it('carries 0, never null, for a bucket with no rows', () => {
    const series = computeSeries(countInput([[47, 3]]), SPEC, NOW);

    expect(series.points[46]?.value).toBe(0);
    expect(series.points.every((p) => p.value !== null)).toBe(true);
  });

  it('sums the current window into value and the preceding one into baseline', () => {
    const series = computeSeries(
      countInput([
        [0, 5],
        [23, 7],
        [24, 1],
        [47, 2],
      ]),
      SPEC,
      NOW,
    );

    expect(series.baseline).toBe(12);
    expect(series.value).toBe(3);
  });

  it('reads spark as the current-window tail of points', () => {
    const series = computeSeries(
      countInput([
        [23, 9],
        [47, 4],
      ]),
      SPEC,
      NOW,
    );

    expect(series.spark).toHaveLength(24);
    expect(series.spark).toEqual(series.points.slice(-24).map((p) => p.value ?? 0));
    expect(series.spark[23]).toBe(4);
    expect(series.spark[0]).toBe(0);
  });
});

describe('computeSeries — a ratio', () => {
  const ratioInput = (num: Array<[number, number]>, den: Array<[number, number]>, scale = 1) => ({
    num: mapAt(num),
    den: mapAt(den),
    scale,
  });

  it('carries null for a bucket whose denominator is zero', () => {
    const series = computeSeries(ratioInput([[47, 3]], [[47, 4]]), SPEC, NOW);

    expect(series.points[47]?.value).toBe(0.75);
    expect(series.points[46]?.value).toBeNull();
  });

  it('distinguishes a zero numerator over a real denominator from an absent bucket', () => {
    const series = computeSeries(ratioInput([], [[47, 4]]), SPEC, NOW);

    expect(series.points[47]?.value).toBe(0);
    expect(series.points[46]?.value).toBeNull();
  });

  it('divides the window totals, not the per-bucket ratios', () => {
    const series = computeSeries(
      ratioInput(
        [
          [46, 1],
          [47, 3],
        ],
        [
          [46, 1],
          [47, 9],
        ],
      ),
      SPEC,
      NOW,
    );

    expect(series.value).toBe(0.4);
  });

  it('reports a null value where the whole window denominator is zero', () => {
    const series = computeSeries(ratioInput([[47, 3]], []), SPEC, NOW);

    expect(series.value).toBeNull();
    expect(series.baseline).toBeNull();
  });

  it('applies the scale to points, value and baseline alike', () => {
    const series = computeSeries(
      ratioInput(
        [
          [0, 1],
          [47, 3],
        ],
        [
          [0, 2],
          [47, 4],
        ],
        100,
      ),
      SPEC,
      NOW,
    );

    expect(series.points[47]?.value).toBe(75);
    expect(series.value).toBe(75);
    expect(series.baseline).toBe(50);
    expect(series.spark[23]).toBe(75);
  });

  it('reads a null bucket as zero in the spark, keeping the glance tile compatible', () => {
    const series = computeSeries(ratioInput([[47, 3]], [[47, 4]]), SPEC, NOW);

    expect(series.points[46]?.value).toBeNull();
    expect(series.spark[22]).toBe(0);
  });
});

describe('deltaPct', () => {
  it('is the percentage move from baseline to value', () => {
    expect(deltaPct(75, 50)).toBe(50);
    expect(deltaPct(0.25, 0.5)).toBe(-50);
  });

  // cm:guard a zero baseline yields null, NEVER Infinity — the tile renders the number it is given, and "+∞%" beside a figure that merely started from nothing is the state-lies failure VISION №10 forbids.
  it('is null where either side is null or the baseline is zero', () => {
    expect(deltaPct(1, 0)).toBeNull();
    expect(deltaPct(null, 5)).toBeNull();
    expect(deltaPct(5, null)).toBeNull();
  });
});

describe('toGlance', () => {
  it('publishes value, its delta against baseline, and the spark', () => {
    const series = computeSeries(
      {
        num: mapAt([
          [0, 2],
          [47, 3],
        ]),
        den: null,
        scale: 1,
      },
      SPEC,
      NOW,
    );

    expect(toGlance(series)).toEqual({
      value: 3,
      deltaPct: 50,
      spark: series.spark,
    });
  });
});
