/**
 * OAuth providers API — used by the (auth) layout's SocialLogin server
 * component to know which buttons to render. Only the public list shape;
 * actual auth flow happens via full-page navigation to /api/auth/oauth/:p/start.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';

export type OAuthProviderId = 'github' | 'google' | 'oidc';

export interface OAuthProviderPublic {
  id: OAuthProviderId;
  label: string;
}

interface ProvidersResponse {
  providers: OAuthProviderPublic[];
}

/**
 * Server-side fetch (SSR friendly). Returns `[]` when the social-auth flag
 * is off, the backend is unreachable, or the response is malformed —
 * never throws so the auth page can render normally.
 */
export async function fetchOAuthProviders(): Promise<OAuthProviderPublic[]> {
  try {
    const res = await fetch(`${API_URL}/auth/oauth/providers`, {
      headers: { Accept: 'application/json' },
      // Brief revalidation — the operator might toggle env vars + restart
      // core, and we don't want to hold a stale empty list for the entire
      // ISR cache window.
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as ProvidersResponse;
    return json.providers ?? [];
  } catch {
    return [];
  }
}

/** Public URL the browser navigates to for /:provider/start. */
export function startUrl(providerId: OAuthProviderId, redirectTo = '/projects'): string {
  const qs = new URLSearchParams({ redirect: redirectTo });
  return `${API_URL}/auth/oauth/${providerId}/start?${qs.toString()}`;
}
