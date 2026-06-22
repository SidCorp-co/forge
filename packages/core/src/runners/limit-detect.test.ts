import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIMIT_COOLDOWN_MS,
  detectRunnerLimit,
  isAuthError,
  isRateLimitError,
  isUsageLimitError,
  parseUsageLimitReset,
} from './limit-detect.js';

describe('isUsageLimitError', () => {
  it('matches the runner [USAGE_LIMIT] token', () => {
    expect(isUsageLimitError('[USAGE_LIMIT] out of extra usage; resets 4am (US/Eastern)')).toBe(
      true,
    );
  });

  it('matches "you\'ve hit your limit … resets <time>"', () => {
    expect(
      isUsageLimitError("You've hit your 5-hour limit. Your limit resets 11am (Asia/Bangkok)."),
    ).toBe(true);
    expect(isUsageLimitError("You've hit your weekly limit · resets Jun 4, 2pm (US/Eastern)")).toBe(
      true,
    );
  });

  it('matches "out of extra usage … resets <time>"', () => {
    expect(isUsageLimitError('out of extra usage, resets 12am (America/Los_Angeles)')).toBe(true);
  });

  it('loose-matches short error-only text without a reset phrase', () => {
    expect(isUsageLimitError('out of extra usage')).toBe(true);
  });

  it('does NOT match a long agent response merely discussing usage limits', () => {
    const essay = `Here is a long explanation of how usage limits work. ${'x'.repeat(400)} you might hit your limit eventually.`;
    expect(isUsageLimitError(essay)).toBe(false);
  });

  it('is false for empty / unrelated text', () => {
    expect(isUsageLimitError('')).toBe(false);
    expect(isUsageLimitError('ECONNRESET')).toBe(false);
  });
});

describe('isRateLimitError', () => {
  it('matches 429 and rate-limit phrasing', () => {
    expect(isRateLimitError('Request failed: 429 Too Many Requests')).toBe(true);
    expect(isRateLimitError('rate_limit_error')).toBe(true);
    expect(isRateLimitError('rate-limit hit')).toBe(true);
  });
  it('is false otherwise', () => {
    expect(isRateLimitError('ETIMEDOUT')).toBe(false);
  });
});

describe('isAuthError', () => {
  it('matches the 401 invalid-credentials message from the prompt', () => {
    expect(
      isAuthError('Failed to authenticate. API Error: 401 Invalid authentication credentials'),
    ).toBe(true);
  });
  it('matches other 401 / auth phrasings', () => {
    expect(isAuthError('API Error: 401')).toBe(true);
    expect(isAuthError('401 unauthorized')).toBe(true);
    expect(isAuthError('invalid authentication credentials')).toBe(true);
  });
  it('is false for unrelated errors', () => {
    expect(isAuthError('429 rate limited')).toBe(false);
  });
  it('does not match a long body where 401 and the keyword are far apart', () => {
    const essay = `The HTTP status 401 is one of many. ${'x'.repeat(200)} the word unauthorized appears much later.`;
    expect(isAuthError(essay)).toBe(false);
  });
  it('still matches 401 with a nearby keyword', () => {
    expect(isAuthError('Error 401: unauthorized request')).toBe(true);
  });
});

describe('parseUsageLimitReset', () => {
  beforeEach(() => {
    // Pin "now" to a fixed instant so tomorrow/today inference is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T08:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('parses a bare time with timezone into a future UTC instant', () => {
    const reset = parseUsageLimitReset('resets 11am (UTC)');
    expect(reset).toBeInstanceOf(Date);
    // 11am UTC same day is after 08:00 UTC now.
    expect(reset!.toISOString()).toBe('2026-06-22T11:00:00.000Z');
  });

  it('rolls to tomorrow when the reset time already passed today', () => {
    const reset = parseUsageLimitReset('resets 5am (UTC)');
    expect(reset!.toISOString()).toBe('2026-06-23T05:00:00.000Z');
  });

  it('parses a dated reset ("Month day, time")', () => {
    const reset = parseUsageLimitReset('resets Jun 25, 2pm (UTC)');
    expect(reset!.toISOString()).toBe('2026-06-25T14:00:00.000Z');
  });

  it('returns null when no reset phrase is present', () => {
    expect(parseUsageLimitReset('out of extra usage')).toBeNull();
  });

  it('rolls the year forward for a dated reset far behind the current month', () => {
    vi.setSystemTime(new Date('2026-12-28T08:00:00.000Z'));
    // "Jan 2" seen in late December means next January, not this year's.
    const reset = parseUsageLimitReset('resets Jan 2, 9am (UTC)');
    expect(reset!.toISOString()).toBe('2027-01-02T09:00:00.000Z');
  });
});

describe('detectRunnerLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T08:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('classifies a usage limit with parsed reset time', () => {
    const out = detectRunnerLimit('[USAGE_LIMIT] out of extra usage; resets 11am (UTC)');
    expect(out).not.toBeNull();
    expect(out!.reason).toBe('usage_limit');
    expect(out!.until!.toISOString()).toBe('2026-06-22T11:00:00.000Z');
    expect(out!.detail).not.toContain('[USAGE_LIMIT]');
  });

  it('falls back to default cooldown for a usage limit with no reset phrase', () => {
    const out = detectRunnerLimit('out of extra usage');
    expect(out!.reason).toBe('usage_limit');
    expect(out!.until!.getTime()).toBe(Date.now() + DEFAULT_LIMIT_COOLDOWN_MS);
  });

  it('classifies a 401 as auth with no reset time', () => {
    const out = detectRunnerLimit(
      'Failed to authenticate. API Error: 401 Invalid authentication credentials',
    );
    expect(out!.reason).toBe('auth');
    expect(out!.until).toBeNull();
  });

  it('classifies a 429 as rate_limit, preferring the provider Retry-After', () => {
    const retryAfter = new Date('2026-06-22T08:30:00.000Z');
    const out = detectRunnerLimit('429 Too Many Requests', retryAfter);
    expect(out!.reason).toBe('rate_limit');
    expect(out!.until!.toISOString()).toBe(retryAfter.toISOString());
  });

  it('prefers usage_limit over auth/rate when multiple signals overlap', () => {
    const out = detectRunnerLimit(
      '[USAGE_LIMIT] 429 you have been rate limited; resets 11am (UTC)',
    );
    expect(out!.reason).toBe('usage_limit');
  });

  it('returns null for non-limit failures', () => {
    expect(detectRunnerLimit('ECONNRESET')).toBeNull();
    expect(detectRunnerLimit('')).toBeNull();
  });
});
