import { createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetInstallationTokenCache,
  buildAppJwt,
  GitHubAuthError,
  installationToken,
} from './app-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const NOW = 1_800_000_000_000;

function decode(part: string) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
    string,
    number | string
  >;
}

function tokenResponse(token: string, expiresAt: string) {
  return new Response(JSON.stringify({ token, expires_at: expiresAt }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => __resetInstallationTokenCache());

describe('buildAppJwt', () => {
  it('signs a verifiable RS256 JWT issued by the app id', () => {
    const jwt = buildAppJwt('123456', privateKey, NOW);
    const [header, payload, signature] = jwt.split('.');
    expect(decode(header as string)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload as string).iss).toBe('123456');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature as string, 'base64url'))).toBe(true);
  });

  it('backdates iat and stays inside the ten-minute ceiling', () => {
    const claims = decode(buildAppJwt('1', privateKey, NOW).split('.')[1] as string);
    const now = Math.floor(NOW / 1000);
    expect(Number(claims.iat)).toBeLessThan(now);
    expect(Number(claims.exp) - now).toBeLessThan(600);
  });
});

describe('installationToken', () => {
  const args = { appId: '1', privateKey, installationId: 42, nowMs: NOW };

  it('mints against the installation endpoint and reuses the token until near expiry', async () => {
    const fetchImpl = vi.fn(async () =>
      tokenResponse('ghs_first', new Date(NOW + 3600_000).toISOString()),
    ) as unknown as typeof fetch;

    const a = await installationToken({ ...args, fetchImpl });
    const b = await installationToken({ ...args, fetchImpl, nowMs: NOW + 60_000 });

    expect(a).toBe('ghs_first');
    expect(b).toBe('ghs_first');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(init.method).toBe('POST');
  });

  it('re-mints once the token is inside the refresh margin', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      tokenResponse(`ghs_${++n}`, new Date(NOW + 3600_000).toISOString()),
    ) as unknown as typeof fetch;

    await installationToken({ ...args, fetchImpl });
    const later = await installationToken({ ...args, fetchImpl, nowMs: NOW + 3600_000 - 60_000 });

    expect(later).toBe('ghs_2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('separates a bad App credential (401) from an App that is not installed (404)', async () => {
    const status = (code: number) =>
      vi.fn(async () => new Response('', { status: code })) as unknown as typeof fetch;

    const unauthorized = await installationToken({ ...args, fetchImpl: status(401) }).catch(
      (e) => e,
    );
    expect(unauthorized).toBeInstanceOf(GitHubAuthError);
    expect((unauthorized as GitHubAuthError).status).toBe(401);
    expect((unauthorized as Error).message).toMatch(/App id and private key/);

    const missing = await installationToken({ ...args, fetchImpl: status(404) }).catch((e) => e);
    expect((missing as GitHubAuthError).status).toBe(404);
    expect((missing as Error).message).toMatch(/never installed/);
  });
});
