import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetGoogleTokenCache,
  buildAssertion,
  googleAccessToken,
  parseServiceAccountKey,
} from './auth.js';
import { GOOGLE_SCOPES, SHEETS_READONLY_SCOPE, SHEETS_READWRITE_SCOPE } from './scopes.js';
import { GoogleAuthError } from './types.js';

// A real RSA pair, so the assertion is VERIFIED rather than merely recorded: a
// test that reads the JWT out of the request body and never checks its
// signature stays green for a key that signs nothing.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const KEY_FILE = JSON.stringify({
  type: 'service_account',
  project_id: 'forge-sheets-1',
  private_key_id: 'kid-7',
  private_key: privateKey,
  client_email: 'forge@forge-sheets-1.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const CONN = 'conn-google-1';

interface Recorded {
  url: string;
  body: URLSearchParams;
}

/** A token endpoint that records what Forge sent and answers with a token. */
function tokenEndpoint(opts: { status?: number; expiresIn?: number; token?: string } = {}) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: new URLSearchParams(String(init?.body ?? '')),
    });
    const status = opts.status ?? 200;
    if (status !== 200) return new Response('{"error":"invalid_grant"}', { status });
    return new Response(
      JSON.stringify({
        access_token: opts.token ?? 'ya29.minted-token',
        expires_in: opts.expiresIn ?? 3600,
        token_type: 'Bearer',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

afterEach(() => {
  __resetGoogleTokenCache();
});

describe('parseServiceAccountKey', () => {
  it('refuses a body that is not a service-account key file, by name', () => {
    expect(() => parseServiceAccountKey('not json')).toThrow(GoogleAuthError);
    expect(() => parseServiceAccountKey('{"type":"user"}')).toThrow(/service-account key file/);
  });

  it('reads the account identity out of a real key file', () => {
    const key = parseServiceAccountKey(KEY_FILE);
    expect(key.client_email).toBe('forge@forge-sheets-1.iam.gserviceaccount.com');
    expect(key.project_id).toBe('forge-sheets-1');
  });
});

describe('the assertion Forge signs (criterion 4)', () => {
  it('verifies against the account public key and carries iss, aud, scope and a backdated iat', () => {
    const now = 1_760_000_000_000;
    const jwt = buildAssertion(parseServiceAccountKey(KEY_FILE), SHEETS_READONLY_SCOPE, now);
    const [header, payload, signature] = jwt.split('.');

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(String(signature), 'base64url'))).toBe(true);

    expect(decodeSegment(String(header))).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'kid-7' });
    const claims = decodeSegment(String(payload));
    expect(claims.iss).toBe('forge@forge-sheets-1.iam.gserviceaccount.com');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.scope).toBe(SHEETS_READONLY_SCOPE);
    // Backdated by 60s — Google rejects an iat in its own future, which a box
    // with a slightly fast clock produces.
    expect(claims.iat).toBe(Math.floor(now / 1000) - 60);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
  });

  it('a signature over different claims does not verify — the check above can fail', () => {
    const jwt = buildAssertion(parseServiceAccountKey(KEY_FILE), SHEETS_READONLY_SCOPE, 1_000);
    const [header, , signature] = jwt.split('.');
    const tampered = Buffer.from(JSON.stringify({ iss: 'someone-else' })).toString('base64url');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${tampered}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(String(signature), 'base64url'))).toBe(false);
  });
});

describe('scopes (criteria 8, 9)', () => {
  it('a read mints the read-only scope alone', async () => {
    const ep = tokenEndpoint();
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
    });
    const claims = decodeSegment(String(ep.calls[0]?.body.get('assertion')?.split('.')[1]));
    expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    expect(ep.calls[0]?.body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
    );
  });

  it('a write mints the read-write scope alone', async () => {
    const ep = tokenEndpoint();
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READWRITE_SCOPE,
      fetchImpl: ep.impl,
    });
    const claims = decodeSegment(String(ep.calls[0]?.body.get('assertion')?.split('.')[1]));
    expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets');
  });

  it('no scope this integration can request reaches Drive', () => {
    for (const scope of GOOGLE_SCOPES) expect(scope).not.toContain('/auth/drive');
    expect(GOOGLE_SCOPES).toHaveLength(2);
  });
});

describe('the token cache (criteria 5, 6, 7)', () => {
  it('reuses a minted token until shortly before it expires', async () => {
    const ep = tokenEndpoint({ expiresIn: 3600 });
    const first = await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
      nowMs: 1_000_000,
    });
    const second = await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
      nowMs: 1_000_000 + 3_000_000,
    });
    expect(ep.calls).toHaveLength(1);
    expect(second.token).toBe(first.token);
  });

  it('mints again once the cached token is inside the refresh margin', async () => {
    const ep = tokenEndpoint({ expiresIn: 3600 });
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
      nowMs: 1_000_000,
    });
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
      nowMs: 1_000_000 + 3_600_000,
    });
    expect(ep.calls).toHaveLength(2);
  });

  it('a read token is never handed to a write — the cache is keyed on the scope too', async () => {
    const ep = tokenEndpoint();
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
      nowMs: 1_000_000,
    });
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READWRITE_SCOPE,
      fetchImpl: ep.impl,
      nowMs: 1_000_000,
    });
    expect(ep.calls).toHaveLength(2);
  });

  it('forceMint bypasses a warm cache, so the credential stored now is the one tested', async () => {
    const ep = tokenEndpoint();
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
      nowMs: 1_000_000,
    });
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
      nowMs: 1_000_000,
      forceMint: true,
    });
    expect(ep.calls).toHaveLength(2);
  });
});

describe('what Google refusing the account looks like', () => {
  it('a 400 from the token endpoint is a rejection the operator must act on', async () => {
    const ep = tokenEndpoint({ status: 400 });
    await expect(
      googleAccessToken({
        connectionId: CONN,
        serviceAccountJson: KEY_FILE,
        scope: SHEETS_READONLY_SCOPE,
        fetchImpl: ep.impl,
      }),
    ).rejects.toMatchObject({ kind: 'rejected', status: 400 });
  });

  it('a 500 is transport, not a credential to replace', async () => {
    const ep = tokenEndpoint({ status: 503 });
    await expect(
      googleAccessToken({
        connectionId: CONN,
        serviceAccountJson: KEY_FILE,
        scope: SHEETS_READONLY_SCOPE,
        fetchImpl: ep.impl,
      }),
    ).rejects.toMatchObject({ kind: 'transport', status: 503 });
  });

  it('nothing Google said is echoed back to the caller', async () => {
    const ep = tokenEndpoint({ status: 400 });
    await googleAccessToken({
      connectionId: CONN,
      serviceAccountJson: KEY_FILE,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl: ep.impl,
    }).catch((err: Error) => {
      expect(err.message).not.toContain('invalid_grant');
    });
  });
});
