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
import {
  buildRepoClient,
  GitHubClientError,
  GitHubPublishError,
  GitHubReadError,
} from './client.js';

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

/**
 * The publish helper, which is a different door from `get` for one reason: a
 * publish refusal is worded from evidence `get` throws away. Every assertion
 * below is about something that survives the helper and would not survive
 * `get` — the operation, the mint-or-repository origin, the headers, the body.
 */
describe('one request on the publish path', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    __resetInstallationTokenCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mintOk = () =>
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ token: 'ghs_installation', expires_at: '2099-01-01T00:00:00Z' }),
    });

  const publishErr = async (fn: () => Promise<unknown>): Promise<GitHubPublishError> => {
    const err = await fn().then(
      () => null,
      (e: unknown) => e,
    );
    if (!(err instanceof GitHubPublishError)) {
      throw new Error(`expected a GitHubPublishError, got ${String(err)}`);
    }
    return err;
  };

  it('mints with the App JWT and sends the installation token to the repository', async () => {
    mintOk();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 9 }) });
    const client = buildRepoClient(args());
    await client.publish({ op: 'create', method: 'POST', path: '/repos/x/y/check-runs', body: {} });

    const [mintUrl, mintInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [repoUrl, repoInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(mintUrl).toContain('/app/installations/42/access_tokens');
    expect((mintInit.headers as Record<string, string>).Authorization).toMatch(/^Bearer eyJ/);
    expect(repoUrl).toBe('https://api.github.com/repos/x/y/check-runs');
    expect((repoInit.headers as Record<string, string>).Authorization).toBe(
      'Bearer ghs_installation',
    );
  });

  it('sends the body as JSON on a write and sends none on a lookup', async () => {
    mintOk();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    const client = buildRepoClient(args());
    await client.publish({ op: 'lookup', method: 'GET', path: '/repos/x/y/check-runs' });
    const init = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await client.publish({
      op: 'update',
      method: 'PATCH',
      path: '/repos/x/y/check-runs/1',
      body: { conclusion: 'success' },
    });
    const write = (fetchMock.mock.calls[2] as [string, RequestInit])[1];
    expect(write.body).toBe('{"conclusion":"success"}');
    expect((write.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('keeps a mint failure labelled as the mint, with app-auth`s own words', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({}),
    });
    const client = buildRepoClient(args());
    const err = await publishErr(() =>
      client.publish({ op: 'create', method: 'POST', path: '/repos/x/y/check-runs', body: {} }),
    );
    expect(err.op).toBe('mint');
    expect(err.status).toBe(404);
    expect(err.message).toContain('does not exist for this App');
  });

  it('carries the response headers a rate limit is told from a permission by', async () => {
    mintOk();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789000000' }),
      text: async () => '{"message":"API rate limit exceeded"}',
    });
    const client = buildRepoClient(args());
    const err = await publishErr(() =>
      client.publish({ op: 'create', method: 'POST', path: '/repos/x/y/check-runs', body: {} }),
    );
    expect(err.op).toBe('create');
    expect(err.headers?.get('x-ratelimit-remaining')).toBe('0');
    expect(err.detail).toContain('rate limit exceeded');
  });

  it('labels a lookup failure as the lookup, not as the write that never happened', async () => {
    mintOk();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: async () => '',
    });
    const client = buildRepoClient(args());
    const err = await publishErr(() =>
      client.publish({ op: 'lookup', method: 'GET', path: '/repos/x/y/check-runs' }),
    );
    expect(err.op).toBe('lookup');
    expect(err.timedOut).toBe(false);
  });

  it('marks a timed-out request as timed out rather than as a status', async () => {
    mintOk();
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(abort);
    const client = buildRepoClient(args());
    const err = await publishErr(() =>
      client.publish({ op: 'create', method: 'POST', path: '/repos/x/y/check-runs', body: {} }),
    );
    expect(err.timedOut).toBe(true);
    expect(err.status).toBeNull();
    expect(err.op).toBe('create');
  });

  it('keeps the operation when a successful response`s body stalls to the timeout', async () => {
    mintOk();
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'TimeoutError';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        throw abort;
      },
    });
    const client = buildRepoClient(args());
    const err = await publishErr(() =>
      client.publish({ op: 'lookup', method: 'GET', path: '/repos/x/y/check-runs' }),
    );
    expect(err.op).toBe('lookup');
    expect(err.timedOut).toBe(true);
    expect(err.message).toContain('body could not be read');
  });

  it('survives a refusal whose body cannot be read, rather than throwing over it', async () => {
    mintOk();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => {
        throw new Error('stream already consumed');
      },
    });
    const client = buildRepoClient(args());
    const err = await publishErr(() =>
      client.publish({ op: 'update', method: 'PATCH', path: '/repos/x/y/check-runs/1', body: {} }),
    );
    expect(err.status).toBe(500);
    expect(err.detail).toBeNull();
  });
});
