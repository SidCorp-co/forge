/**
 * Authenticating as a GitHub App installation.
 *
 * Two hops, and they are not interchangeable: a JWT signed with the App's
 * private key proves *which App* this is, and only that JWT can mint the
 * installation access token that acts on a repository. The installation token
 * is what every repository call carries.
 */

import { createSign } from 'node:crypto';
import { GITHUB_API_BASE } from './types.js';

const JWT_LIFETIME_S = 540;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const MINT_TIMEOUT_MS = 8000;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

// cm:guard `exp` must stay under GitHub's 10-minute ceiling and `iat` must be backdated — GitHub rejects a JWT whose `iat` is in its own future, which is what a box with a clock a few seconds fast produces. 60 seconds of backdating costs nothing and removes a failure that presents as an unexplained 401 on a credential that is fine.
export function buildAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + JWT_LIFETIME_S, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKeyPem).toString('base64url')}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, InstallationToken>();

export function __resetInstallationTokenCache(): void {
  cache.clear();
}

export class GitHubAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Mint (or reuse) an installation access token. GitHub issues these for one
 * hour; the cache hands one back until five minutes before it lapses.
 */
export async function installationToken(args: {
  appId: string;
  privateKey: string;
  installationId: number;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<string> {
  const base = (args.apiBaseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
  const now = args.nowMs ?? Date.now();
  const key = `${base}|${args.appId}|${args.installationId}`;

  const hit = cache.get(key);
  if (hit && hit.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return hit.token;

  const doFetch = args.fetchImpl ?? fetch;
  const res = await doFetch(`${base}/app/installations/${args.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${buildAppJwt(args.appId, args.privateKey, now)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });

  // cm:guard 401 means the APP credential is wrong (bad key, wrong appId, skewed clock); 404 means the App is not installed on that account, which is an operator authorising it again, not replacing a credential. Reporting either as the other sends the operator to the wrong page.
  if (res.status === 401) {
    throw new GitHubAuthError(
      401,
      'GitHub rejected the App JWT — check the App id and private key',
    );
  }
  if (res.status === 404) {
    throw new GitHubAuthError(
      404,
      `installation ${args.installationId} does not exist for this App — it was removed, or the App was never installed on that account`,
    );
  }
  if (!res.ok) {
    throw new GitHubAuthError(
      res.status,
      `minting an installation token returned HTTP ${res.status}`,
    );
  }

  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new GitHubAuthError(500, 'GitHub returned no installation token');
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : now + 3600_000;
  cache.set(key, { token: body.token, expiresAt });
  return body.token;
}
