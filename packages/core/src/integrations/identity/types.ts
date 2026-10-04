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

/** The per-login secrets the browser carries between start and callback, in the signed cookie. */
interface LoginChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface LoginStart {
  url: string;
  checks: LoginChecks;
}

export interface LoginFinish {
  /** The callback URL as the provider redirected to it, query included. */
  callbackUrl: URL;
  checks: LoginChecks;
}

export interface OAuthProvider {
  /** Mint the login's state, nonce and PKCE pair and the URL that sends the browser to sign in. */
  start(cfg: ProviderConfig, redirectUri: string): Promise<LoginStart>;
  /** Check the callback against the login's own checks, exchange the code, return the identity. */
  finish(cfg: ProviderConfig, args: LoginFinish): Promise<OAuthIdentity>;
}
