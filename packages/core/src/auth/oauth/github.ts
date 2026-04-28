/**
 * GitHub provider — plain OAuth 2.0 (no id_token).
 *
 * Why two API calls in `callback`: GitHub's `/user` endpoint returns the
 * profile but its `email` field can be `null` if the user marked their
 * email private. The /user/emails endpoint always returns the verified
 * primary email when `user:email` scope is granted, so we use that as the
 * source of truth.
 */

import type { ProviderConfig } from './providers.js';
import type {
  AuthorizeArgs,
  CallbackArgs,
  OAuthIdentity,
  OAuthProvider,
} from './types.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export const githubProvider: OAuthProvider = {
  async buildAuthorizeUrl(cfg: ProviderConfig, args: AuthorizeArgs): Promise<string> {
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: args.redirectUri,
      scope: cfg.scopes.join(' '),
      state: args.state,
      // GitHub doesn't support PKCE on its OAuth surface; including the
      // challenge is harmless (ignored) but documents intent.
      allow_signup: 'true',
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  },

  async callback(cfg: ProviderConfig, args: CallbackArgs): Promise<OAuthIdentity> {
    // Token exchange — POST form-encoded, ask for JSON in response.
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code: args.code,
        redirect_uri: args.redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`github: token exchange returned HTTP ${tokenRes.status}`);
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenJson.access_token) {
      throw new Error(`github: token exchange failed (${tokenJson.error ?? 'no token'})`);
    }
    const accessToken = tokenJson.access_token;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    const [userRes, emailsRes] = await Promise.all([
      fetch(USER_URL, { headers }),
      fetch(EMAILS_URL, { headers }),
    ]);
    if (!userRes.ok) throw new Error(`github: /user returned HTTP ${userRes.status}`);
    const user = (await userRes.json()) as GitHubUser;

    // /user/emails may 404 if the token didn't get user:email — fall back
    // to whatever /user returned (which can be null if email is private).
    let primary: GitHubEmail | null = null;
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as GitHubEmail[];
      primary = emails.find((e) => e.primary && e.verified) ?? null;
    }

    const email = primary?.email ?? user.email;
    return {
      providerAccountId: String(user.id),
      email: email ? email.toLowerCase() : null,
      emailVerified: primary !== null,
    };
  },
};
