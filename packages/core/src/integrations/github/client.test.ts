/**
 * The five refusals, and the header every read carries.
 *
 * Each refusal sends an operator somewhere different, so each is asserted by the
 * thing that distinguishes it — the word an operator would act on — rather than
 * by a message equality that a rewrite would break without meaning anything.
 * ISS-924 is the failure being avoided: a 403 reported as `needs_reauth` sends
 * someone to replace a credential that works.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetInstallationTokenCache } from './app-auth.js';
import { buildRepoClient, GitHubClientError, GitHubReadError } from './client.js';

// cm:guard a REAL key, because the signing is real: `buildAppJwt` calls `createSign().sign()`, and a placeholder PEM fails inside node's decoder with `error:1E08010C` — an exception that is not the one under test and reads like the code being broken.
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function args(over: { config?: Record<string, unknown>; secrets?: Record<string, unknown> } = {}) {
  return {
    bindingId: 'binding-1',
    config: { owner: 'SidCorp-co', repo: 'forge', installationId: 42, ...over.config },
    secrets: { appId: '1', privateKey: PRIVATE_KEY, ...over.secrets },
  };
}

function refusalOf(build: () => unknown): GitHubClientError {
  try {
    build();
  } catch (err) {
    if (err instanceof GitHubClientError) return err;
    throw err;
  }
  throw new Error('expected a GitHubClientError and none was thrown');
}

describe('building a repository client refuses by naming what is missing', () => {
  it('names the repository where the binding has none', () => {
    const err = refusalOf(() => buildRepoClient(args({ config: { owner: undefined } })));
    expect(err.reason).toBe('no_repository');
    expect(err.message).toMatch(/owner\/repo/);
  });

  // cm:guard this refusal must say INSTALL and must not say reconnect — ISS-924's mislabel is the failure it is worded against, and reconnecting reproduces the state exactly.
  it('names installation, and says reconnecting will not help, where the App is not installed', () => {
    const err = refusalOf(() => buildRepoClient(args({ config: { installationId: undefined } })));
    expect(err.reason).toBe('no_installation');
    expect(err.message).toMatch(/install it on the account/i);
    expect(err.message).toMatch(/reconnecting will not change this/i);
  });

  it('names the credential where the connection holds no App key', () => {
    const err = refusalOf(() => buildRepoClient(args({ secrets: { privateKey: undefined } })));
    expect(err.reason).toBe('no_credential');
  });

  it('names the credential where the App id is missing, not the repository', () => {
    const err = refusalOf(() => buildRepoClient(args({ secrets: { appId: undefined } })));
    expect(err.reason).toBe('no_credential');
  });

  it('carries the binding`s own spelling of the repository into the message', () => {
    const err = refusalOf(() => buildRepoClient(args({ config: { installationId: undefined } })));
    expect(err.message).toContain('SidCorp-co/forge');
  });
});

describe('a read as the installation', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    __resetInstallationTokenCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mintOk() {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ token: 'ghs_installation', expires_at: '2099-01-01T00:00:00Z' }),
    });
  }

  // cm:guard the Authorization header is the whole of ISS-1062's identity rule — every read Forge makes is the App, and a personal token reaching this path is exactly what the issue exists to remove. Assert the value, not merely that a header was sent.
  it('sends the installation token and no person`s credential', async () => {
    mintOk();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
    const client = buildRepoClient(args());
    await client.get('/repos/SidCorp-co/forge/pulls/1');

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/SidCorp-co/forge/pulls/1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_installation');
    expect((init.headers as Record<string, string>)['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('reads an enterprise host where the binding names one', async () => {
    mintOk();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    const client = buildRepoClient(
      args({ config: { apiBaseUrl: 'https://ghe.example.com/api/v3' } }),
    );
    await client.get('/repos/x/y');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://ghe.example.com/api/v3/repos/x/y');
  });

  it('carries the status so a caller can tell a 404 from a 403', async () => {
    mintOk();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    const client = buildRepoClient(args());
    await expect(client.get('/repos/x/y')).rejects.toMatchObject({
      name: 'GitHubReadError',
      status: 403,
    });
  });

  it('reports a rejected App credential as a read failure carrying GitHub`s own status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const client = buildRepoClient(args());
    const err = await client.get('/repos/x/y').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubReadError);
    expect((err as GitHubReadError).status).toBe(401);
  });
});
