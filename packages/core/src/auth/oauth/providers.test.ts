import { describe, it, expect, vi } from 'vitest';

// Mock env BEFORE importing the module — providers.ts captures `env` at
// import time so we set up a fixture-driven `env` object per test by
// re-mocking and re-importing.
function loadProvidersWithEnv(envOverrides: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('../../config/env.js', () => ({
    env: {
      APP_BASE_URL: 'http://localhost:3000',
      OIDC_LABEL: 'Continue with SSO',
      OIDC_SCOPES: 'openid email profile',
      ...envOverrides,
    },
  }));
  return import('./providers.js');
}

describe('oauth provider registry', () => {
  it('returns empty list when nothing is configured', async () => {
    const { getEnabledProviders } = await loadProvidersWithEnv({});
    expect(getEnabledProviders()).toEqual([]);
  });

  it('omits a provider when only one half of the credential pair is set', async () => {
    const { getEnabledProviders } = await loadProvidersWithEnv({
      GITHUB_OAUTH_CLIENT_ID: 'gh-id',
      // GITHUB_OAUTH_CLIENT_SECRET intentionally missing
    });
    expect(getEnabledProviders()).toEqual([]);
  });

  it('enables GitHub when both id + secret are present', async () => {
    const { getEnabledProviders } = await loadProvidersWithEnv({
      GITHUB_OAUTH_CLIENT_ID: 'gh-id',
      GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
    });
    const list = getEnabledProviders();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'github', label: 'Continue with GitHub' });
  });

  it('returns all 3 providers when all envs are populated', async () => {
    const { getEnabledProviders } = await loadProvidersWithEnv({
      GITHUB_OAUTH_CLIENT_ID: 'gh-id',
      GITHUB_OAUTH_CLIENT_SECRET: 'gh-secret',
      GOOGLE_OIDC_CLIENT_ID: 'goog-id',
      GOOGLE_OIDC_CLIENT_SECRET: 'goog-secret',
      OIDC_ISSUER_URL: 'https://auth.example.com',
      OIDC_CLIENT_ID: 'oidc-id',
      OIDC_CLIENT_SECRET: 'oidc-secret',
    });
    const list = getEnabledProviders();
    expect(list.map((p) => p.id)).toEqual(['github', 'google', 'oidc']);
  });

  it('uses operator-supplied OIDC_LABEL for the generic provider', async () => {
    const { getEnabledProviders } = await loadProvidersWithEnv({
      OIDC_LABEL: 'Continue with junixlabs SSO',
      OIDC_ISSUER_URL: 'https://auth.junixlabs.com',
      OIDC_CLIENT_ID: 'id',
      OIDC_CLIENT_SECRET: 'secret',
    });
    const oidc = getEnabledProviders().find((p) => p.id === 'oidc');
    expect(oidc?.label).toBe('Continue with junixlabs SSO');
  });

  it('callback URL falls back to APP_BASE_URL when OAUTH_REDIRECT_BASE is unset', async () => {
    const { getCallbackUrl } = await loadProvidersWithEnv({
      APP_BASE_URL: 'https://app.example.com',
    });
    expect(getCallbackUrl('github')).toBe('https://app.example.com/api/auth/oauth/github/callback');
  });

  it('callback URL trims trailing slashes from the base', async () => {
    const { getCallbackUrl } = await loadProvidersWithEnv({
      OAUTH_REDIRECT_BASE: 'https://api.example.com/',
    });
    expect(getCallbackUrl('google')).toBe(
      'https://api.example.com/api/auth/oauth/google/callback',
    );
  });
});
