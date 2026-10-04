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
