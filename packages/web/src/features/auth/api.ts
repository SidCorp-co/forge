import { apiClient, coreFileUrl } from '@/lib/api/client';

export type ReauthResponse = {
  freshAuthAt: string;
};

export interface OAuthProviderInfo {
  id: string;
  label: string;
}

export const authApi = {
  reauth: (password: string) =>
    apiClient<ReauthResponse>('/auth/reauth', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  oauthProviders: () =>
    apiClient<{ providers: OAuthProviderInfo[] }>('/auth/oauth/providers'),
};

/**
 * Builds the top-level navigation URL that bounces the user through their
 * existing OAuth provider for a freshness re-confirmation. The callback
 * stamps `users.last_fresh_auth_at` only — it does NOT issue a new auth
 * cookie. See packages/core/src/auth/oauth/routes.ts.
 *
 * Returns an absolute URL anchored at the core API origin so it works when
 * web and core are deployed on different hosts. Safe to pass directly to
 * `window.location.assign(...)`.
 */
export function oauthReauthUrl(provider: string, returnPath: string): string {
  return coreFileUrl(
    `/api/auth/oauth/${provider}/reauth-start?redirect=${encodeURIComponent(returnPath)}`,
  );
}
