import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';

// ISS-1047: a stand-in for a product whose owner acts take a person's OAuth access token, as
// Agenfold's do, for the integration tests of core's owner sign-in and refresh.

export const CLIENT_ID = 'forge-owner-client';
const b64url = (b: Buffer) => b.toString('base64url');
const token = (prefix: string) => `${prefix}_${b64url(randomBytes(18))}`;

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
  /** How long the token endpoint waits before it answers a refresh, so two acts overlap in it. */
  refreshDelayMs = 0;
  private access = new Map<string, number>();
  private refresh = new Map<string, 'live' | 'spent' | 'revoked'>();
  private codes = new Map<string, { challenge: string; redirect: string }>();
  private server!: Server;

  /** A fresh pair, as a sign-in would give: an access token living `lifetimeSec`, and its refresh token. */
  mint(lifetimeSec: number): { accessToken: string; refreshToken: string } {
    const accessToken = token('agf_at');
    const refreshToken = token('agf_rt');
    this.access.set(accessToken, Date.now() + lifetimeSec * 1000);
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

  /** The owner signs in and confirms: where the product sends his browser back. */
  async confirm(authorizeUrl: string): Promise<URL> {
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
        const pair = () => {
          const p = this.mint(lifetimeSec);
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
          return json(200, pair());
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
      this.calls.push({ url: url.pathname, auth, body });
      const presented = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
      const until = this.access.get(presented);
      if (until === undefined || until < Date.now()) {
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
