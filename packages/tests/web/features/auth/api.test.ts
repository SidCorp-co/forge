import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CORE_ORIGIN = 'https://core-beta.sidcorp.co';

describe('oauthReauthUrl', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', `${CORE_ORIGIN}/api`);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an absolute URL anchored at the core origin', async () => {
    const { oauthReauthUrl } = await import('@/features/auth/api');
    const url = oauthReauthUrl('github', '/settings/tokens');
    expect(url).toBe(
      `${CORE_ORIGIN}/api/auth/oauth/github/reauth-start?redirect=%2Fsettings%2Ftokens`,
    );
    expect(url.startsWith('http')).toBe(true);
  });

  it('percent-encodes query characters inside the redirect parameter', async () => {
    const { oauthReauthUrl } = await import('@/features/auth/api');
    const url = oauthReauthUrl('github', '/settings/tokens?from=x');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/auth/oauth/github/reauth-start');
    expect(parsed.searchParams.get('redirect')).toBe('/settings/tokens?from=x');
    expect(url).toContain('redirect=%2Fsettings%2Ftokens%3Ffrom%3Dx');
  });

  it('works for non-github providers (google)', async () => {
    const { oauthReauthUrl } = await import('@/features/auth/api');
    const url = oauthReauthUrl('google', '/settings/tokens');
    expect(url).toBe(
      `${CORE_ORIGIN}/api/auth/oauth/google/reauth-start?redirect=%2Fsettings%2Ftokens`,
    );
  });
});
