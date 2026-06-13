import { describe, expect, it } from 'vitest';
import { estimateCost, lookupPricing } from './pricing.js';

// ISS-438 — the pricing table must know every model the fleet actually runs,
// and a generic family prefix must never shadow a more specific version key
// (the old first-match loop priced Opus 4.5–4.8 at the 4.0/4.1 rate, 3× high).
describe('lookupPricing', () => {
  it('knows claude-fable-5 ($10/$50, default cache rates)', () => {
    expect(lookupPricing('claude-fable-5')).toEqual({
      input: 10.0,
      output: 50.0,
      cacheRead: 1.0,
      cacheCreation: 12.5,
    });
  });

  it('prices Opus 4.5–4.8 at $5/$25 — the specific key beats the claude-opus-4 prefix', () => {
    for (const m of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']) {
      expect(lookupPricing(m)).toEqual({
        input: 5.0,
        output: 25.0,
        cacheRead: 0.5,
        cacheCreation: 6.25,
      });
    }
  });

  it('keeps Opus 4.0/4.1 on the legacy $15/$75 family rate', () => {
    expect(lookupPricing('claude-opus-4-1')?.input).toBe(15.0);
    expect(lookupPricing('claude-opus-4-20250514')?.output).toBe(75.0);
  });

  it('prices haiku-4-5 at $1/$5 (not the 3.5 rate)', () => {
    expect(lookupPricing('claude-haiku-4-5-20251001')).toEqual({
      input: 1.0,
      output: 5.0,
      cacheRead: 0.1,
      cacheCreation: 1.25,
    });
  });

  it('matches dated/suffixed ids by substring and is case-insensitive', () => {
    expect(lookupPricing('Claude-Sonnet-4-6')?.input).toBe(3.0);
    expect(lookupPricing('us.anthropic.claude-opus-4-8-v1')?.input).toBe(5.0);
  });

  it('returns null for unknown models (estimateCost → 0)', () => {
    expect(lookupPricing('<synthetic>')).toBeNull();
    expect(estimateCost('<synthetic>', { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });
});

describe('estimateCost', () => {
  it('sums all four token classes at the model rates', () => {
    // 1M of each on fable-5: 10 + 50 + 1 + 12.5
    expect(
      estimateCost('claude-fable-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      }),
    ).toBe(73.5);
  });

  it('rounds to 5 decimals', () => {
    expect(estimateCost('claude-opus-4-8', { inputTokens: 1, outputTokens: 1 })).toBe(0.00003);
  });
});
