import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';

// ISS-1047: a stand-in for a product whose owner acts take a person's OAuth access token, as
// Agenfold's do, for the integration tests of core's owner sign-in and refresh. ISS-1052: each
// sign-in is made by one of the product's accounts, which its id_token (when `openid` is asked for)
// and its userinfo endpoint name.

export const CLIENT_ID = 'forge-owner-client';
const b64url = (b: Buffer) => b.toString('base64url');
const token = (prefix: string) => `${prefix}_${b64url(randomBytes(18))}`;

/** One of the product's own accounts, as its id_token and userinfo name it. */
export interface ProductAccount {
  sub: string;
  email: string;
}

/** The owner's account at the product, the one his binding names. */
export const OWNER_ACCOUNT: ProductAccount = { sub: 'agf-user-1001', email: 'Alice@Agenfold.test' };
/** Somebody else's account at the same product: whoever opened a forwarded link. */
export const OTHER_ACCOUNT: ProductAccount = { sub: 'agf-user-2002', email: 'mallory@agenfold.test' };

/**
 * Agenfold as its owner acts see it: an OAuth server (authorization code with PKCE, and refresh
 * tokens that are single-use and rotate, a spent one revoking its whole chain) and the one API call
 * an owner act makes, which takes a live, unexpired access token and nothing else.
 */
export class OauthProduct {
  base = '';
  /** Every token it ever issued: none may ever reach the session. */
  readonly issued: string[] = [];
  readonly calls: { url: string; auth: string | undefined; body: string }[] = [];
  readonly refreshes: { refreshToken: string; answered: number }[] = [];
  readonly codeTrades: { verifierOk: boolean; redirect: string | null }[] = [];
  /** The access tokens its userinfo endpoint was asked about. */
  readonly userinfoAsks: string[] = [];
  /** Who signs in at the product's page next: the owner, unless a test hands the link on. */
  signingIn: ProductAccount = OWNER_ACCOUNT;
  /** How long the token endpoint waits before it answers a refresh, so two acts overlap in it. */
  refreshDelayMs = 0;
  private access = new Map<string, { until: number; account: ProductAccount }>();
  private refresh = new Map<string, 'live' | 'spent' | 'revoked'>();
  private codes = new Map<
    string,
    { challenge: string; redirect: string; account: ProductAccount; openid: boolean }
  >();
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private server!: Server;

  /** A fresh pair, as a sign-in would give: an access token living `lifetimeSec`, and its refresh token. */
  mint(
    lifetimeSec: number,
    account: ProductAccount = OWNER_ACCOUNT,
  ): { accessToken: string; refreshToken: string } {
    const accessToken = token('agf_at');
    const refreshToken = token('agf_rt');
    this.access.set(accessToken, { until: Date.now() + lifetimeSec * 1000, account });
    this.refresh.set(refreshToken, 'live');
    this.issued.push(accessToken, refreshToken);
    return { accessToken, refreshToken };
  }

  /** The owner revokes Forge's access in the product: the refresh token is dead from now. */
  revoke(refreshToken: string): void {
    this.refresh.set(refreshToken, 'revoked');
  }

  refreshState(refreshToken: string) {
    return this.refresh.get(refreshToken);
  }

  /** An id_token for `account`, signed RS256, issued by this product to Forge's client. */
  private idToken(account: ProductAccount): string {
    const now = Math.floor(Date.now() / 1000);
    const part = (v: unknown) => b64url(Buffer.from(JSON.stringify(v)));
    const head = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      iss: this.base,
      aud: CLIENT_ID,
      sub: account.sub,
      email: account.email,
      email_verified: true,
      iat: now,
      exp: now + 600,
    })}`;
    return `${head}.${b64url(sign('sha256', Buffer.from(head), this.keys.privateKey))}`;
  }

  /**
   * Somebody signs in at the product's page and confirms: where the product sends the browser back.
   * The owner, unless `as` names whoever else opened the link.
   */
  async confirm(authorizeUrl: string, as: ProductAccount = OWNER_ACCOUNT): Promise<URL> {
    this.signingIn = as;
    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    return new URL(String(res.headers.get('location')));
  }

  async start(lifetimeSec: number): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://product');
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === '/oauth/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== CLIENT_ID || q.get('code_challenge_method') !== 'S256') {
          return json(400, { error: 'invalid_request' });
        }
        const issuedCode = token('agf_code');
        this.codes.set(issuedCode, {
          challenge: String(q.get('code_challenge')),
          redirect: String(q.get('redirect_uri')),
          account: this.signingIn,
          openid: (q.get('scope') ?? '').split(' ').includes('openid'),
        });
        const back = new URL(String(q.get('redirect_uri')));
        back.searchParams.set('code', issuedCode);
        back.searchParams.set('state', String(q.get('state')));
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(body);
        if (form.get('client_id') !== CLIENT_ID) return json(401, { error: 'invalid_client' });
        const pair = (account: ProductAccount = OWNER_ACCOUNT) => {
          const p = this.mint(lifetimeSec, account);
          return {
            access_token: p.accessToken,
            refresh_token: p.refreshToken,
            token_type: 'Bearer',
            expires_in: lifetimeSec,
          };
        };
        if (form.get('grant_type') === 'authorization_code') {
          const held = this.codes.get(String(form.get('code')));
          this.codes.delete(String(form.get('code')));
          const verifier = String(form.get('code_verifier'));
          const verifierOk =
            held?.challenge === b64url(createHash('sha256').update(verifier).digest());
          this.codeTrades.push({ verifierOk, redirect: form.get('redirect_uri') });
          if (!held || !verifierOk || held.redirect !== form.get('redirect_uri')) {
            return json(400, { error: 'invalid_grant' });
          }
          return json(200, {
            ...pair(held.account),
            ...(held.openid ? { id_token: this.idToken(held.account) } : {}),
          });
        }
        if (form.get('grant_type') === 'refresh_token') {
          const presented = String(form.get('refresh_token'));
          const entry = { refreshToken: presented, answered: 0 };
          this.refreshes.push(entry);
          await new Promise((r) => setTimeout(r, this.refreshDelayMs));
          const state = this.refresh.get(presented);
          if (state !== 'live') {
            entry.answered = 400;
            return json(400, {
              error: 'invalid_grant',
              error_description: `refresh token ${state ?? 'unknown'}`,
            });
          }
          this.refresh.set(presented, 'spent');
          entry.answered = 200;
          return json(200, pair());
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      const auth = req.headers.authorization;
      const presented = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
      const live = this.access.get(presented);
      if (url.pathname === '/oauth/userinfo') {
        this.userinfoAsks.push(presented);
        if (!live || live.until < Date.now()) return json(401, { error: 'invalid_token' });
        return json(200, { sub: live.account.sub, email: live.account.email, email_verified: true });
      }
      this.calls.push({ url: url.pathname, auth, body });
      if (!live || live.until < Date.now()) {
        return json(401, { error: 'the access token is expired or unknown' });
      }
      // a careless API echoes the credential back
      return json(201, {
        id: 'org-1',
        name: (JSON.parse(body) as { name: string }).name,
        debug: auth,
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
