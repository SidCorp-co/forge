/**
 * Provider registry — config-driven from `env`.
 *
 * A provider is "enabled" only when ALL of its required env vars are set.
 * The frontend asks `/api/auth/oauth/providers` for the live list, so the
 * UI never has to know which buttons to show — that's a server decision
 * keyed off whoever runs the deployment.
 */

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
  /**
   * Provider issuer URL — used for OIDC discovery. `null` for non-OIDC
   * providers (GitHub) where authorize/token/userinfo URLs are hardcoded.
   */
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

function resolveProvider(id: ProviderId): ProviderConfig | null {
  if (id === 'github') {
    if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return null;
    return {
      id,
      label: 'Continue with GitHub',
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      // `read:user` exposes the public profile; `user:email` is required to
      // fetch the (verified) primary email. Both are minimum-scope reads.
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
  // Generic OIDC. The label is operator-controlled via OIDC_LABEL because
  // "Continue with SSO" reads cleaner than the issuer URL on a button.
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

export function getProvider(id: ProviderId): ProviderConfig | null {
  return resolveProvider(id);
}

export function getEnabledProviders(): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const id of ['github', 'google', 'oidc'] as const) {
    const cfg = resolveProvider(id);
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
