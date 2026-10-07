import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT_COOLDOWN_MS, detectRunnerLimit } from './limit-detect.js';

const HOUR = 60 * 60 * 1000;

// ISS-276: a printed reset is the account's claim. It may bring the next try forward; it never
// holds work past the default cooldown, and it is kept beside the hold as what the account said.
describe('detectRunnerLimit: the next try is never pushed out by a printed reset', () => {
  it('holds a usage limit that printed a reset hours away only for the default cooldown', () => {
    const now = new Date();
    const zone = 'UTC';
    const at = new Date(now.getTime() + 5 * HOUR);
    const clock = `${((at.getUTCHours() + 11) % 12) + 1}${at.getUTCHours() < 12 ? 'am' : 'pm'}`;
    const limit = detectRunnerLimit(`You've hit your limit · resets ${clock} (${zone})`, null, now);
    expect(limit?.reason).toBe('usage_limit');
    expect(limit?.refusedAt).toEqual(now);
    expect(limit?.nextTryAt).toEqual(new Date(now.getTime() + DEFAULT_LIMIT_COOLDOWN_MS));
    expect(limit?.printedResetAt?.getTime()).toBeGreaterThan(now.getTime() + 4 * HOUR);
  });

  it('brings the next try forward to a printed reset sooner than the cooldown', () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 20 * 60 * 1000);
    const hh = soon.getUTCHours();
    const mm = String(soon.getUTCMinutes()).padStart(2, '0');
    const clock = `${((hh + 11) % 12) + 1}:${mm}${hh < 12 ? 'am' : 'pm'}`;
    const limit = detectRunnerLimit(`You've hit your limit · resets ${clock} (UTC)`, null, now);
    expect(limit?.printedResetAt).not.toBeNull();
    expect(limit?.nextTryAt).toEqual(limit?.printedResetAt);
    expect(limit?.nextTryAt?.getTime()).toBeLessThan(now.getTime() + DEFAULT_LIMIT_COOLDOWN_MS);
  });

  it('takes a Retry-After sooner than both', () => {
    const now = new Date();
    const retry = new Date(now.getTime() + 1000);
    const limit = detectRunnerLimit("You've hit your limit · resets 4am (UTC)", retry, now);
    expect(limit?.nextTryAt).toEqual(retry);
  });

  it('holds a usage limit with no printed reset for the cooldown and records no claim', () => {
    const now = new Date();
    const limit = detectRunnerLimit("You've hit your usage limit", null, now);
    expect(limit).toMatchObject({ reason: 'usage_limit', printedResetAt: null });
    expect(limit?.nextTryAt).toEqual(new Date(now.getTime() + DEFAULT_LIMIT_COOLDOWN_MS));
  });

  it('gives an auth failure no next try', () => {
    const now = new Date();
    expect(
      detectRunnerLimit('API Error: 401 invalid authentication credentials', null, now),
    ).toMatchObject({ reason: 'auth', nextTryAt: null, printedResetAt: null, refusedAt: now });
  });
});
