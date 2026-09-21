import { apiClient } from '@/lib/api/client';

export type OAuthProviderId = 'github' | 'google' | 'oidc';

export interface OAuthProviderPublic {
  id: OAuthProviderId;
  label: string;
}

interface ProvidersResponse {
  providers: OAuthProviderPublic[];
}

export async function fetchOAuthProviders(): Promise<OAuthProviderPublic[]> {
  try {
    const res = await apiClient<ProvidersResponse>('/auth/oauth/providers');
    return res.providers ?? [];
  } catch {
    return [];
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

/**
 * Full-page URL the browser navigates to for `:provider/start`. The
 * post-callback `redirect` defaults to `/` so core lands the authenticated
 * user back in the web-v2 shell (web-v2 serves at root since ISS-397).
 */
export function startUrl(providerId: OAuthProviderId, redirectTo = '/'): string {
  const qs = new URLSearchParams({ redirect: redirectTo });
  return `${API_BASE}/auth/oauth/${providerId}/start?${qs.toString()}`;
}

export function reauthStartUrl(providerId: string, returnTo: string): string {
  const qs = new URLSearchParams({ redirect: returnTo });
  return `${API_BASE}/auth/oauth/${providerId}/reauth-start?${qs.toString()}`;
}
