/**
 * Shared types for OAuth/OIDC providers. The 3 implementations (GitHub,
 * Google, generic OIDC) all conform to `OAuthProvider`; the handler in
 * `handler.ts` only ever talks to this interface.
 */

import type { ProviderConfig } from './providers.js';

/** What a provider returns once we've finished the dance. */
export interface OAuthIdentity {
  /** Stable, opaque user id from the provider. `sub` for OIDC, `id` for GitHub. */
  providerAccountId: string;
  /** Lower-cased email. May be null if the provider refuses to share it. */
  email: string | null;
  /**
   * Whether the provider has *verified* the email address (DKIM/click-through
   * etc.). We only auto-link to existing accounts when this is true.
   */
  emailVerified: boolean;
}

export interface AuthorizeArgs {
  state: string;
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
}

export interface CallbackArgs {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

export interface OAuthProvider {
  /** Build the URL to send the browser to in /:provider/start. */
  buildAuthorizeUrl(cfg: ProviderConfig, args: AuthorizeArgs): Promise<string>;
  /** Exchange the auth code, fetch userinfo, return a normalised identity. */
  callback(cfg: ProviderConfig, args: CallbackArgs): Promise<OAuthIdentity>;
}
