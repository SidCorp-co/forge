// The owner's OAuth client for a product (ISS-1047, REQ-85 BC-2, BC-3): what the support-api binding
// declares as `ownerSignIn` (the authorization and token endpoints, and the public client Forge is
// registered as there), made into the same `openid-client` configuration Forge's own sign-in uses
// (`integrations/identity/oidc.ts`), with the endpoints given rather than discovered: authorization
// code with PKCE (S256), the code traded and the refresh token spent at the token endpoint. Every
// answer of the token endpoint is read into one of three: tokens, a refusal the product means for
// good (the refresh token is spent or revoked), or no answer worth trusting yet (network, 429, 5xx).
// No token is ever logged or put in a refusal's words. ISS-1052: who signed in is read from the
// id_token the code trade returns (its `iss` the binding's `issuer`, else the token endpoint's
// origin, and its `aud` Forge's client) or from the userinfo endpoint the binding declares.

import type { SupportApiConnectionConfig, SupportOwnerSignIn } from '@forge/contracts/support';
import * as client from 'openid-client';
import { env } from '../../lib/env.js';
import { grantedHosts, hostGranted } from './call.js';

const TOKEN_TIMEOUT_SECONDS = 10;

/** Where the product sends the owner's browser back to, registered as the client's redirect there. */
export function ownerSignInCallbackUrl(): string {
  const base = env.PUBLIC_API_BASE_URL ?? env.OAUTH_REDIRECT_BASE ?? env.APP_BASE_URL;
  return `${base.replace(/\/+$/, '')}/api/support/owner-sign-in/callback`;
}

/** Plain http is a local product's, as Forge's own sign-in allows it; anywhere else, https only. */
const insecureAllowed = (url: URL) =>
  url.protocol === 'http:' && (env.NODE_ENV === 'development' || env.NODE_ENV === 'test');

/** The origin of an endpoint on plain http where this core may not use one; null where it may. */
const plainHttp = (url: URL): string | null =>
  url.protocol === 'http:' && !insecureAllowed(url) ? url.origin : null;

/** The product's OAuth client, or why core cannot use what the binding declares, as the support door words it. */
export type OwnerOauthClient =
  | { ok: true; value: client.Configuration }
  | { ok: false; code: 'SUPPORT_OWNER_SIGN_IN_UNDECLARED'; detail: string };

/**
 * The product's OAuth client, or the refusal naming why core cannot use what the binding declares:
 * none declared, a token or userinfo endpoint on a host the connection does not grant, or plain http.
 */
export function ownerOauthClient(
  product: string,
  signIn: SupportOwnerSignIn | null,
  config: SupportApiConnectionConfig,
): OwnerOauthClient {
  const refuse = (why: string): OwnerOauthClient => ({
    ok: false,
    code: 'SUPPORT_OWNER_SIGN_IN_UNDECLARED',
    detail: `${why}, so Forge can neither start the owner's sign-in to ${product} nor refresh his token there, and nothing was sent. Its support-api binding declares ownerSignIn { authorizationUrl, tokenUrl, clientId, scopes? }, with the token endpoint on a host the connection grants and ${ownerSignInCallbackUrl()} registered as the client's redirect.`,
  });
  if (!signIn) return refuse(`the support-api binding of ${product} declares no ownerSignIn`);
  const token = new URL(signIn.tokenUrl);
  const authorize = new URL(signIn.authorizationUrl);
  const userinfo = signIn.userinfoUrl ? new URL(signIn.userinfoUrl) : null;
  const hosts = grantedHosts(config);
  const ungranted = !hostGranted(token, hosts)
    ? `the token endpoint ${token.host}`
    : userinfo && !hostGranted(userinfo, hosts)
      ? `the userinfo endpoint ${userinfo.host}`
      : null;
  if (ungranted) {
    return refuse(
      `${ungranted} is on no host the ${product} connection grants (${[...hosts].join(', ')})`,
    );
  }
  const plain = plainHttp(token) ?? plainHttp(authorize) ?? (userinfo && plainHttp(userinfo));
  if (plain) return refuse(`${plain} is plain http, and the owner's tokens travel only over https`);
  const configuration = new client.Configuration(
    {
      issuer: signIn.issuer ?? token.origin,
      authorization_endpoint: signIn.authorizationUrl,
      token_endpoint: signIn.tokenUrl,
      ...(signIn.userinfoUrl ? { userinfo_endpoint: signIn.userinfoUrl } : {}),
    },
    signIn.clientId,
    undefined,
    client.None(),
  );
  configuration.timeout = TOKEN_TIMEOUT_SECONDS;
  if (
    token.protocol === 'http:' ||
    authorize.protocol === 'http:' ||
    userinfo?.protocol === 'http:'
  ) {
    client.allowInsecureRequests(configuration);
  }
  return { ok: true, value: configuration };
}

/** The tokens a product gave: the access token, the refresh token where it gave one, and its expiry. */
export interface OwnerTokens {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: string | null;
}

/** Who the product says signed in, as its id_token or userinfo endpoint names the account. */
export interface SignedInClaims {
  sub: string;
  email: string | undefined;
  /** False only where the product says the email is not verified. */
  emailVerified: boolean | undefined;
}

const claimsOf = (raw: Record<string, unknown>): SignedInClaims => ({
  sub: String(raw.sub),
  email: typeof raw.email === 'string' ? raw.email : undefined,
  emailVerified: typeof raw.email_verified === 'boolean' ? raw.email_verified : undefined,
});

export type TokenAnswer =
  | { kind: 'ok'; tokens: OwnerTokens }
  /** The product refused for good: the code or refresh token is spent, revoked or not its client's. */
  | { kind: 'refused'; reason: string }
  /** No answer to act on: unreachable, timed out, rate-limited or a server error. */
  | { kind: 'transient'; reason: string };

const tokensOf = (
  answer: client.TokenEndpointResponse,
  now: number,
  kept?: string,
): OwnerTokens => ({
  accessToken: answer.access_token,
  // a product that does not rotate answers no new refresh token: the one presented stays good
  refreshToken: answer.refresh_token ?? kept,
  expiresAt:
    typeof answer.expires_in === 'number' && answer.expires_in > 0
      ? new Date(now + answer.expires_in * 1000).toISOString()
      : null,
});

/** The status a token endpoint's error answered with, where it was an HTTP answer at all. */
function statusOf(err: unknown): number | null {
  if (err instanceof client.ResponseBodyError) return err.status;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Response ? cause.status : null;
}

/** Why, in the product's own OAuth words, never a token: `invalid_grant: refresh token revoked`. */
function reasonOf(err: unknown): string {
  if (err instanceof client.ResponseBodyError) {
    return `${err.error}${err.error_description ? `: ${err.error_description.slice(0, 200)}` : ''}`;
  }
  const status = statusOf(err);
  if (status !== null) return `http_${status}`;
  const message = err instanceof Error ? err.message : String(err);
  return `unreachable: ${message.slice(0, 200)}`;
}

/** A token endpoint's or userinfo endpoint's error, as the refusal or the wait it means. */
type NoAnswer = Exclude<TokenAnswer, { kind: 'ok' }>;

function answerOfError(err: unknown): NoAnswer {
  const status = statusOf(err);
  if (status === null || status === 429 || status >= 500) {
    return { kind: 'transient', reason: reasonOf(err) };
  }
  return { kind: 'refused', reason: reasonOf(err) };
}

/** Spend the refresh token for a new pair; a product that rotates answers a new refresh token too. */
export async function refreshOwnerTokens(
  configuration: client.Configuration,
  refreshToken: string,
): Promise<TokenAnswer> {
  const now = Date.now();
  try {
    const answer = await client.refreshTokenGrant(configuration, refreshToken);
    return { kind: 'ok', tokens: tokensOf(answer, now, refreshToken) };
  } catch (err) {
    return answerOfError(err);
  }
}

/** A code trade's answer: the tokens, and who its id_token names where it returned one. */
export type CodeAnswer =
  | { kind: 'ok'; tokens: OwnerTokens; idClaims: SignedInClaims | null }
  | NoAnswer;

/**
 * Trade the code the product returned with, checked against the sign-in's own state and verifier;
 * an id_token it returns is checked for its issuer and audience, and its claims handed back.
 */
export async function tradeOwnerCode(
  configuration: client.Configuration,
  input: { code: string; state: string; verifier: string },
): Promise<CodeAnswer> {
  const now = Date.now();
  const back = new URL(ownerSignInCallbackUrl());
  back.searchParams.set('code', input.code);
  back.searchParams.set('state', input.state);
  try {
    const answer = await client.authorizationCodeGrant(configuration, back, {
      pkceCodeVerifier: input.verifier,
      expectedState: input.state,
    });
    const id = answer.claims();
    return { kind: 'ok', tokens: tokensOf(answer, now), idClaims: id ? claimsOf(id) : null };
  } catch (err) {
    return answerOfError(err);
  }
}

/**
 * Who the access token belongs to, as the userinfo endpoint the binding declares answers; where an
 * id_token named a `sub`, the userinfo answer must name the same one.
 */
export async function readOwnerUserinfo(
  configuration: client.Configuration,
  accessToken: string,
  expectedSub: string | null,
): Promise<{ kind: 'ok'; claims: SignedInClaims } | NoAnswer> {
  try {
    const answer = await client.fetchUserInfo(
      configuration,
      accessToken,
      expectedSub ?? client.skipSubjectCheck,
    );
    return { kind: 'ok', claims: claimsOf(answer) };
  } catch (err) {
    return answerOfError(err);
  }
}

/** A fresh sign-in's state and PKCE pair, and the URL that sends the owner's browser to the product. */
export async function ownerAuthorizationUrl(
  configuration: client.Configuration,
  scopes: readonly string[],
): Promise<{ url: string; state: string; verifier: string }> {
  const state = client.randomState();
  const verifier = client.randomPKCECodeVerifier();
  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: ownerSignInCallbackUrl(),
    ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
    state,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return { url: url.href, state, verifier };
}
