import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RETRY_AFTER_CAP_MS,
  MIN_RETRY_COOLDOWN_MS,
  parseRetryAfter,
  readRetryAfterHeader,
} from './retry-after-parser.js';

const FIXED_NOW = new Date('2026-05-23T12:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('parseRetryAfter', () => {
  it('null / undefined / empty string → null', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('   ')).toBeNull();
  });

  it('delta-seconds: integer seconds resolve to now + N*1000', () => {
    const out = parseRetryAfter('600');
    expect(out).toEqual(new Date(FIXED_NOW + 600 * 1000));
  });

  it('delta-seconds: zero resolves to now', () => {
    expect(parseRetryAfter('0')).toEqual(new Date(FIXED_NOW));
  });

  it('delta-seconds: negative is rejected', () => {
    // Regex anchors to ^\d+$ so a leading "-" never matches; explicit guard
    // is defence-in-depth in case the regex is relaxed.
    expect(parseRetryAfter('-5')).toBeNull();
  });

  it('delta-seconds: NaN-looking text falls through to HTTP-date and returns null', () => {
    expect(parseRetryAfter('not-a-number')).toBeNull();
  });

  it('delta-seconds: >24h clamped to MAX cap', () => {
    const out = parseRetryAfter('100000'); // 27.7h
    expect(out).toEqual(new Date(FIXED_NOW + MAX_RETRY_AFTER_CAP_MS));
  });

  it('HTTP-date: future absolute date parses as that instant', () => {
    // 1h ahead of FIXED_NOW
    const target = new Date(FIXED_NOW + 60 * 60 * 1000).toUTCString();
    const out = parseRetryAfter(target);
    expect(out).toEqual(new Date(Date.parse(target)));
  });

  it('HTTP-date: past date returns null', () => {
    const past = new Date(FIXED_NOW - 60 * 60 * 1000).toUTCString();
    expect(parseRetryAfter(past)).toBeNull();
  });

  it('HTTP-date: >24h ahead clamped to MAX cap', () => {
    const farFuture = new Date(FIXED_NOW + 48 * 60 * 60 * 1000).toUTCString();
    const out = parseRetryAfter(farFuture);
    expect(out).toEqual(new Date(FIXED_NOW + MAX_RETRY_AFTER_CAP_MS));
  });

  it('MIN_RETRY_COOLDOWN_MS is exactly 60_000', () => {
    expect(MIN_RETRY_COOLDOWN_MS).toBe(60_000);
  });
});

describe('readRetryAfterHeader', () => {
  it('case-insensitive lookup', () => {
    expect(readRetryAfterHeader({ 'Retry-After': '600' })).toBe('600');
    expect(readRetryAfterHeader({ 'retry-after': '600' })).toBe('600');
    expect(readRetryAfterHeader({ 'RETRY-AFTER': '600' })).toBe('600');
  });

  it('coerces numeric values to string', () => {
    expect(readRetryAfterHeader({ 'retry-after': 600 })).toBe('600');
  });

  it('null / undefined / missing → null', () => {
    expect(readRetryAfterHeader(null)).toBeNull();
    expect(readRetryAfterHeader(undefined)).toBeNull();
    expect(readRetryAfterHeader({})).toBeNull();
    expect(readRetryAfterHeader({ 'content-type': 'json' })).toBeNull();
  });
});
