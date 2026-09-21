import { env } from '../../config/env.js';

export type ProviderId = 'github' | 'google' | 'oidc';

export interface ProviderConfig {
  id: ProviderId;
  /** Human-facing button label, e.g. "Continue with GitHub". */
  label: string;
  /** OAuth 2.0 client id from the provider's developer console. */
  clientId: string;
  /** OAuth 2.0 client secret. */
  clientSecret: string;
  /** Default scopes requested at the authorize step. */
  scopes: string[];
  issuerUrl: string | null;
}

/** Resolve `OAUTH_REDIRECT_BASE` once; fall back to `APP_BASE_URL`. */
export function getRedirectBase(): string {
  return env.OAUTH_REDIRECT_BASE ?? env.APP_BASE_URL;
}

/** Public callback URL that should be registered with each provider. */
export function getCallbackUrl(providerId: ProviderId): string {
  // Trim trailing slash so we never produce `//api/...`.
  const base = getRedirectBase().replace(/\/+$/, '');
  return `${base}/api/auth/oauth/${providerId}/callback`;
}

export function getProvider(id: ProviderId): ProviderConfig | null {
  if (id === 'github') {
    if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return null;
    return {
      id,
      label: 'Continue with GitHub',
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      scopes: ['read:user', 'user:email'],
      issuerUrl: null,
    };
  }
  if (id === 'google') {
    if (!env.GOOGLE_OIDC_CLIENT_ID || !env.GOOGLE_OIDC_CLIENT_SECRET) return null;
    return {
      id,
      label: 'Continue with Google',
      clientId: env.GOOGLE_OIDC_CLIENT_ID,
      clientSecret: env.GOOGLE_OIDC_CLIENT_SECRET,
      scopes: ['openid', 'email', 'profile'],
      issuerUrl: 'https://accounts.google.com',
    };
  }
  if (!env.OIDC_ISSUER_URL || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return null;
  return {
    id,
    label: env.OIDC_LABEL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    scopes: env.OIDC_SCOPES.split(/\s+/).filter(Boolean),
    issuerUrl: env.OIDC_ISSUER_URL.replace(/\/+$/, ''),
  };
}

export function getEnabledProviders(): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const id of ['github', 'google', 'oidc'] as const) {
    const cfg = getProvider(id);
    if (cfg) out.push(cfg);
  }
  return out;
}

/** Public DTO for the `/providers` endpoint — never leaks client secrets. */
export interface PublicProvider {
  id: ProviderId;
  label: string;
}

export function toPublic(cfg: ProviderConfig): PublicProvider {
  return { id: cfg.id, label: cfg.label };
}
