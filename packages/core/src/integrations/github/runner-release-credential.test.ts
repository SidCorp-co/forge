/**
 * Point 4 of ISS-1075, proved without cutting a tag: the request that creates
 * one carries an installation token minted from the App's own credential, and
 * nothing on this path can reach a person's.
 *
 * Two halves, because either alone is weak evidence. The first drives a REAL
 * `buildRepoClient` over a stubbed `fetch` with a freshly generated RSA key and
 * verifies the JWT GitHub would have been sent — signature, issuer and expiry —
 * then verifies the tag create carries the token that JWT bought. The second
 * reads the source of every module on the release path, because a personal
 * credential does not have to be used on the happy path to be reachable: one
 * `process.env.GITHUB_TOKEN` in a fallback branch would satisfy every
 * behavioural test here and still put a person's identity on a tag.
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const { buildRepoClient } = await import('./client.js');
const { __resetInstallationTokenCache } = await import('./app-auth.js');
const { createTagRef } = await import('./runner-release-repo.js');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface Sent {
  url: string;
  method: string;
  authorization: string;
  body: unknown;
}

function stubFetch(sent: Sent[]) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    sent.push({
      url: String(url),
      method: init.method ?? 'GET',
      authorization: headers.get('Authorization') ?? '',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (String(url).endsWith('/access_tokens')) {
      return new Response(
        JSON.stringify({
          token: 'ghs_installation_token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (String(url).endsWith('/git/tags')) {
      return new Response(JSON.stringify({ sha: 'tagobj1', tag: 'runner-v0.13.3' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ ref: 'refs/tags/runner-v0.13.3', object: { sha: 'tagobj1' } }),
      {
        status: 201,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
}

const client = () =>
  buildRepoClient({
    bindingId: 'binding-1',
    config: { owner: 'SidCorp-co', repo: 'forge', installationId: 42 },
    secrets: { appId: '1075', privateKey },
  } as never);

function decodeJwt(token: string) {
  const [header, payload, signature] = token.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  return {
    header: JSON.parse(Buffer.from(String(header), 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(String(payload), 'base64url').toString('utf8')),
    verifies: verifier.verify(publicKey, Buffer.from(String(signature), 'base64url')),
  };
}

beforeEach(() => {
  __resetInstallationTokenCache();
});

describe('the credential the tag is cut with', () => {
  it('is an installation token the App minted for itself, and nothing else', async () => {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', stubFetch(sent));
    await createTagRef(client(), 'runner-v0.13.3', 'abc1234', 'forge-runner 0.13.3');
    vi.unstubAllGlobals();

    // cm:guard the mint happens per CALL, so the annotated tag's two writes are three requests and every one of them carries the installation token. A test asserting only the first write would pass over a second call that fell back to something else.
    expect(sent).toHaveLength(3);
    const [mint, object, cut] = sent;
    expect(mint?.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(mint?.method).toBe('POST');

    const jwt = decodeJwt(String(mint?.authorization).replace('Bearer ', ''));
    // cm:guard the SIGNATURE is verified against the key the connection holds, not merely parsed. A token that decodes is not a token GitHub would accept, and "we sent something JWT-shaped" is exactly the kind of green that proves nothing.
    expect(jwt.verifies).toBe(true);
    expect(jwt.header.alg).toBe('RS256');
    expect(jwt.payload.iss).toBe('1075');
    expect(jwt.payload.exp - jwt.payload.iat).toBeLessThanOrEqual(600);

    expect(object?.url).toBe('https://api.github.com/repos/SidCorp-co/forge/git/tags');
    expect(object?.authorization).toBe('Bearer ghs_installation_token');
    expect(object?.body).toEqual({
      tag: 'runner-v0.13.3',
      message: 'forge-runner 0.13.3',
      object: 'abc1234',
      type: 'commit',
    });

    expect(cut?.url).toBe('https://api.github.com/repos/SidCorp-co/forge/git/refs');
    expect(cut?.method).toBe('POST');
    expect(cut?.authorization).toBe('Bearer ghs_installation_token');
    expect(cut?.body).toEqual({ ref: 'refs/tags/runner-v0.13.3', sha: 'tagobj1' });
  });

  it('sends no request at all when the connection holds no App key', async () => {
    const sent: Sent[] = [];
    vi.stubGlobal('fetch', stubFetch(sent));
    expect(() =>
      buildRepoClient({
        bindingId: 'binding-1',
        config: { owner: 'SidCorp-co', repo: 'forge', installationId: 42 },
        secrets: {},
      } as never),
    ).toThrow(/holds no GitHub App credential/);
    vi.unstubAllGlobals();
    expect(sent).toEqual([]);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));

// cm:guard the modules on the release path, listed rather than globbed: a new module added to this path and not to this list is unscanned, and the whole point of the scan is that a credential fallback nobody exercises is still a credential fallback.
const RELEASE_PATH_MODULES = [
  'runner-release.ts',
  'runner-release-repo.ts',
  'runner-release-events.ts',
  'runner-release-store.ts',
  'runner-release-preflight.ts',
  'runner-release-routes.ts',
  '../../pipeline/runner-release-deadline.ts',
];

describe('what the release path may not reach', () => {
  const sources = RELEASE_PATH_MODULES.map((name) => ({
    name,
    text: readFileSync(join(HERE, name), 'utf8'),
  }));

  it('reads no environment variable', () => {
    for (const { name, text } of sources) {
      expect(`${name}: ${/process\.env/.test(text)}`).toBe(`${name}: false`);
    }
  });

  it('names no personal or environment GitHub token', () => {
    for (const { name, text } of sources) {
      expect(`${name}: ${/GITHUB_TOKEN|GH_TOKEN|ghp_|hosts\.yml/.test(text)}`).toBe(
        `${name}: false`,
      );
    }
  });

  it('shells out nowhere', () => {
    for (const { name, text } of sources) {
      expect(`${name}: ${/child_process|execSync|spawnSync|\bexeca\b/.test(text)}`).toBe(
        `${name}: false`,
      );
    }
  });

  // cm:guard `install/fetch-release.ts` reads `RUNNER_RELEASE_GITHUB_TOKEN` and is the ingestion half, which is a different thing: it pulls a published release off a PUBLIC repo and a token there only raises the rate limit. This assertion is that the two halves stayed apart — the cutting half has no token of its own to fall back on.
  it('does not import the ingestion half, which does hold a token', () => {
    for (const { name, text } of sources) {
      expect(`${name}: ${/from '[^']*install\/fetch-release/.test(text)}`).toBe(`${name}: false`);
    }
  });
});
