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
 * post-callback `redirect` defaults to `/` so core lands the authenticated
 * user back in the web-v2 shell (web-v2 serves at root since ISS-397).
 */
export function startUrl(providerId: OAuthProviderId, redirectTo = '/'): string {
  const qs = new URLSearchParams({ redirect: redirectTo });
  return `${API_BASE}/auth/oauth/${providerId}/start?${qs.toString()}`;
}

/**
 * SSO reauth for password-less users (ISS-167): full-page navigation through
 * the provider with `mode=reauth` — the callback stamps `lastFreshAuthAt`
 * (satisfying `requireFreshAuth` gates like PAT creation) and lands back on
 * `returnTo` with `?reauth=ok` or `?reauth_error=<code>` appended.
 */
export function reauthStartUrl(providerId: string, returnTo: string): string {
  const qs = new URLSearchParams({ redirect: returnTo });
  return `${API_BASE}/auth/oauth/${providerId}/reauth-start?${qs.toString()}`;
}
