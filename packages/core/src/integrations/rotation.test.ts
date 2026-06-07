import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROTATION_WINDOW_MS,
  isPreviousCredentialValid,
  isRotatingProvider,
  mergeRotatedSecrets,
} from './rotation.js';

const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('isRotatingProvider', () => {
  it('recognizes the three rotating providers', () => {
    expect(isRotatingProvider('coolify')).toBe(true);
    expect(isRotatingProvider('postman')).toBe(true);
    expect(isRotatingProvider('epodsystem')).toBe(true);
  });

  it('rejects unknown providers', () => {
    expect(isRotatingProvider('github')).toBe(false);
    expect(isRotatingProvider('')).toBe(false);
  });
});

describe('mergeRotatedSecrets', () => {
  it('coolify: stores previousApiToken + future expiry when rotating', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const merged = mergeRotatedSecrets('coolify', { apiToken: 'old-tok' }, { apiToken: 'new-tok' });
    expect(merged).toEqual({
      apiToken: 'new-tok',
      previousApiToken: 'old-tok',
      previousTokenExpiresAt: new Date(FIXED_NOW + ROTATION_WINDOW_MS).toISOString(),
    });
  });

  it('postman: stores previousApiKey + future expiry when rotating', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const merged = mergeRotatedSecrets('postman', { apiKey: 'PMAK-old' }, { apiKey: 'PMAK-new' });
    expect(merged).toEqual({
      apiKey: 'PMAK-new',
      previousApiKey: 'PMAK-old',
      previousTokenExpiresAt: new Date(FIXED_NOW + ROTATION_WINDOW_MS).toISOString(),
    });
  });

  it('epodsystem: stores previousApiKey + future expiry when rotating', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const merged = mergeRotatedSecrets(
      'epodsystem',
      { apiKey: 'crmk_old' },
      { apiKey: 'crmk_new' },
    );
    expect(merged).toEqual({
      apiKey: 'crmk_new',
      previousApiKey: 'crmk_old',
      previousTokenExpiresAt: new Date(FIXED_NOW + ROTATION_WINDOW_MS).toISOString(),
    });
  });

  it('first credential write: omits previous + expiry when no current secret exists', () => {
    expect(mergeRotatedSecrets('postman', null, { apiKey: 'PMAK-first' })).toEqual({
      apiKey: 'PMAK-first',
    });
    expect(mergeRotatedSecrets('coolify', {}, { apiToken: 'first-tok' })).toEqual({
      apiToken: 'first-tok',
    });
  });

  it('returns null when the incoming payload has no primary credential', () => {
    expect(mergeRotatedSecrets('postman', { apiKey: 'old' }, {})).toBeNull();
    expect(mergeRotatedSecrets('coolify', { apiToken: 'old' }, { apiToken: '' })).toBeNull();
  });

  it('ignores the wrong-shape incoming key (apiKey supplied for coolify is a no-op)', () => {
    // Wrong field for the provider — no primary present, merge skips.
    expect(mergeRotatedSecrets('coolify', { apiToken: 'old' }, { apiKey: 'PMAK-x' })).toBeNull();
  });
});

describe('isPreviousCredentialValid', () => {
  it('returns true when previousTokenExpiresAt is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isPreviousCredentialValid({ previousTokenExpiresAt: future })).toBe(true);
  });

  it('returns false when previousTokenExpiresAt is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isPreviousCredentialValid({ previousTokenExpiresAt: past })).toBe(false);
  });

  it('returns false when previousTokenExpiresAt is missing or malformed', () => {
    expect(isPreviousCredentialValid({})).toBe(false);
    expect(isPreviousCredentialValid(null)).toBe(false);
    expect(isPreviousCredentialValid(undefined)).toBe(false);
    expect(isPreviousCredentialValid({ previousTokenExpiresAt: 'not-a-date' })).toBe(false);
  });
});
