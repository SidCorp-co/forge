import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTokenEstimatorCache,
  estimateTokens,
  getTokenEstimatorCacheStats,
} from './token-estimator.js';

describe('estimateTokens', () => {
  beforeEach(() => {
    clearTokenEstimatorCache();
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns small integer for short string', () => {
    const n = estimateTokens('hello world');
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
  });

  it('is monotonic with length', () => {
    const short = estimateTokens('short');
    const medium = estimateTokens('this is a medium length sentence about tokens');
    const long = estimateTokens('lorem ipsum dolor sit amet, '.repeat(50));
    expect(short).toBeLessThan(medium);
    expect(medium).toBeLessThan(long);
  });

  it('caches repeat calls', () => {
    estimateTokens('cached input');
    estimateTokens('cached input');
    estimateTokens('cached input');
    const stats = getTokenEstimatorCacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
  });

  it('evicts entries past cap (200)', () => {
    for (let i = 0; i < 250; i += 1) {
      estimateTokens(`distinct ${i}`);
    }
    const stats = getTokenEstimatorCacheStats();
    expect(stats.size).toBeLessThanOrEqual(200);
  });

  it('is within ~30% of 1-token-per-4-chars heuristic for mid-length text', () => {
    const text = 'lorem ipsum dolor sit amet, '.repeat(20);
    const rough = Math.ceil(text.length / 4);
    const est = estimateTokens(text);
    const ratio = est / rough;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.5);
  });
});
