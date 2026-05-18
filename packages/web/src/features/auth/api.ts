import { apiClient } from '@/lib/api/client';

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
 */
export function oauthReauthUrl(provider: string, returnPath: string): string {
  return `/api/auth/oauth/${provider}/reauth-start?redirect=${encodeURIComponent(returnPath)}`;
}
