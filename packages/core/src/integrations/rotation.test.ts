import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// cm:why registering the real declarations pulls in every adapter, and coolify's reaches
// db/client.js (and, since ISS-922, queue/boss.js via its confirm enqueue) which parses the
// runtime env at import time — same reason `capabilities.test.ts` stubs both.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    DEVICE_TOKEN_PEPPER: 'test-pepper',
  },
}));

const { registerAllIntegrations } = await import('./register-all.js');
const { getIntegration, listIntegrations } = await import('./registry.js');
const { isPreviousCredentialValid, mergeRotatedSecrets, ROTATION_WINDOW_MS } = await import(
  './rotation.js'
);

/**
 * The declaration, or a failure NAMING the provider.
 *
 * `getIntegration(p)!` reported `Cannot read properties of undefined` and no provider name, which
 * is the least useful possible message for the one thing that can go wrong here — a provider the
 * registry does not hold.
 */
function decl(provider: string) {
  const found = getIntegration(provider);
  if (!found) throw new Error(`no declaration registered for provider=${provider}`);
  return found;
}

const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');

beforeAll(() => {
  registerAllIntegrations();
});

afterEach(() => {
  vi.useRealTimers();
});

// ISS-1071 deleted `isRotatingProvider` and its own per-provider table: whether a provider rotates
// is now a fact its OWN declaration carries (`schemas.primaryCredentialField`), not a second list
// this module keeps in lockstep with the first.
describe('rotation is declared, not listed separately', () => {
  it('a provider rotates iff its declaration carries a primaryCredentialField', () => {
    const rotating = [
      'coolify',
      'postman',
      'epodsystem',
      'sentry',
      'google',
      'rocketchat',
      'github',
    ];
    const notRotating = ['agent'];

    for (const provider of rotating) {
      expect(decl(provider).schemas.primaryCredentialField, provider).not.toBeNull();
    }
    for (const provider of notRotating) {
      expect(decl(provider).schemas.primaryCredentialField, provider).toBeNull();
    }
    // Every declared provider is accounted for on one side or the other.
    expect(
      listIntegrations()
        .map((d) => d.provider)
        .sort(),
    ).toEqual([...rotating, ...notRotating].sort());
  });
});

describe('mergeRotatedSecrets', () => {
  it('coolify: stores previousApiToken + future expiry when rotating', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const coolify = decl('coolify');
    const merged = mergeRotatedSecrets(coolify, { apiToken: 'old-tok' }, { apiToken: 'new-tok' });
    expect(merged).toEqual({
      apiToken: 'new-tok',
      previousApiToken: 'old-tok',
      previousTokenExpiresAt: new Date(FIXED_NOW + ROTATION_WINDOW_MS).toISOString(),
    });
  });

  it('postman: stores previousApiKey + future expiry when rotating', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const postman = decl('postman');
    const merged = mergeRotatedSecrets(postman, { apiKey: 'PMAK-old' }, { apiKey: 'PMAK-new' });
    expect(merged).toEqual({
      apiKey: 'PMAK-new',
      previousApiKey: 'PMAK-old',
      previousTokenExpiresAt: new Date(FIXED_NOW + ROTATION_WINDOW_MS).toISOString(),
    });
  });

  it('epodsystem: stores previousApiKey + future expiry when rotating', () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const epodsystem = decl('epodsystem');
    const merged = mergeRotatedSecrets(epodsystem, { apiKey: 'crmk_old' }, { apiKey: 'crmk_new' });
    expect(merged).toEqual({
      apiKey: 'crmk_new',
      previousApiKey: 'crmk_old',
      previousTokenExpiresAt: new Date(FIXED_NOW + ROTATION_WINDOW_MS).toISOString(),
    });
  });

  it('first credential write: omits previous + expiry when no current secret exists', () => {
    const postman = decl('postman');
    const coolify = decl('coolify');
    expect(mergeRotatedSecrets(postman, null, { apiKey: 'PMAK-first' })).toEqual({
      apiKey: 'PMAK-first',
    });
    expect(mergeRotatedSecrets(coolify, {}, { apiToken: 'first-tok' })).toEqual({
      apiToken: 'first-tok',
    });
  });

  it('returns null when the incoming payload has no primary credential', () => {
    const postman = decl('postman');
    const coolify = decl('coolify');
    expect(mergeRotatedSecrets(postman, { apiKey: 'old' }, {})).toBeNull();
    expect(mergeRotatedSecrets(coolify, { apiToken: 'old' }, { apiToken: '' })).toBeNull();
  });

  it('ignores the wrong-shape incoming key (apiKey supplied for coolify is a no-op)', () => {
    const coolify = decl('coolify');
    expect(mergeRotatedSecrets(coolify, { apiToken: 'old' }, { apiKey: 'PMAK-x' })).toBeNull();
  });

  it('returns null for a declaration with no rotating credential (agent)', () => {
    const agent = decl('agent');
    expect(mergeRotatedSecrets(agent, { anything: 'old' }, { anything: 'new' })).toBeNull();
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
