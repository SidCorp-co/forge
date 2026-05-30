/**
 * OAuth providers API. The provider list is fetched client-side via `apiClient`
 * (same-origin `/api`, so the dev/CI proxy + httpOnly cookie work the same as
 * every other call); the actual sign-in is a full-page navigation to the core
 * `/start` endpoint — never an `apiClient` request (it's a 302 redirect dance,
 * not JSON). Adapted from `packages/web/src/lib/api/oauth-api.ts`.
 */
import { apiClient } from '@/lib/api/client';

export type OAuthProviderId = 'github' | 'google' | 'oidc';

export interface OAuthProviderPublic {
  id: OAuthProviderId;
  label: string;
}

interface ProvidersResponse {
  providers: OAuthProviderPublic[];
}

/**
 * Returns `[]` when social auth is off, the backend is unreachable, or the
 * response is malformed — never throws, so the auth page renders normally
 * (just without OAuth buttons).
 */
export async function fetchOAuthProviders(): Promise<OAuthProviderPublic[]> {
  try {
    const res = await apiClient<ProvidersResponse>('/auth/oauth/providers');
    return res.providers ?? [];
  } catch {
    return [];
  }
}

// Same-origin API base. NOT prefixed by Next's basePath (`/v2`): this is the
// `href` of a plain `<a>`, which the browser resolves against the origin, so
// `/api/...` correctly escapes the basePath and hits core directly.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

/**
 * Full-page URL the browser navigates to for `:provider/start`. The
 * post-callback `redirect` defaults to the absolute `/v2` so core lands the
 * authenticated user back in the web-v2 shell (an absolute path escapes the
 * basePath the same way the API base does).
 */
export function startUrl(providerId: OAuthProviderId, redirectTo = '/v2'): string {
  const qs = new URLSearchParams({ redirect: redirectTo });
  return `${API_BASE}/auth/oauth/${providerId}/start?${qs.toString()}`;
}
