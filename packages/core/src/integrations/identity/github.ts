import { Octokit } from '@octokit/core';
import * as client from 'openid-client';
import type {
  LoginFinish,
  LoginStart,
  OAuthIdentity,
  OAuthProvider,
  ProviderConfig,
} from './types.js';

/** GitHub's OAuth surface is plain OAuth 2.0: no discovery document, no id_token. */
const GITHUB_AUTHORIZATION_SERVER: client.ServerMetadata = {
  issuer: 'https://github.com',
  authorization_endpoint: 'https://github.com/login/oauth/authorize',
  token_endpoint: 'https://github.com/login/oauth/access_token',
};

const configFor = (cfg: ProviderConfig) =>
  new client.Configuration(
    GITHUB_AUTHORIZATION_SERVER,
    cfg.clientId,
    undefined,
    client.ClientSecretPost(cfg.clientSecret),
  );

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export const githubProvider: OAuthProvider = {
  async start(cfg: ProviderConfig, redirectUri: string): Promise<LoginStart> {
    const checks = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      codeVerifier: client.randomPKCECodeVerifier(),
    };
    const url = client.buildAuthorizationUrl(configFor(cfg), {
      redirect_uri: redirectUri,
      scope: cfg.scopes.join(' '),
      state: checks.state,
      code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
      code_challenge_method: 'S256',
      allow_signup: 'true',
    });
    return { url: url.href, checks };
  },

  async finish(cfg: ProviderConfig, args: LoginFinish): Promise<OAuthIdentity> {
    const tokens = await client.authorizationCodeGrant(configFor(cfg), args.callbackUrl, {
      pkceCodeVerifier: args.checks.codeVerifier,
      expectedState: args.checks.state,
    });
    const github = new Octokit({ auth: tokens.access_token });
    const [user, emails] = await Promise.all([
      github.request('GET /user'),
      // Absent without the user:email grant; the identity then has no verified address.
      github.request('GET /user/emails').catch(() => null),
    ]);
    const primary =
      (emails?.data as GitHubEmail[] | undefined)?.find((e) => e.primary && e.verified) ?? null;
    const email = primary?.email ?? user.data.email;
    return {
      providerAccountId: String(user.data.id),
      email: email ? email.toLowerCase() : null,
      emailVerified: primary !== null,
    };
  },
};
