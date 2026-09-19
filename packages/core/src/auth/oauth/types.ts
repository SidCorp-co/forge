import type { ProviderConfig } from './providers.js';

export interface OAuthIdentity {
  providerAccountId: string;
  /** Lower-cased email. May be null if the provider refuses to share it. */
  email: string | null;
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
