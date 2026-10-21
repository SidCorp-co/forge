import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ISS-1421 r20 — judge-82 replaced a Sentry, Postman and Epodsystem key with a wrong one and Test
 * connection passed on the previous key, so the person left believing the new key worked and the
 * connection broke a day later. Test connection judges the key last saved: where the provider
 * refuses it and the previous one still works, it is Needs re-auth saying so; a provider that keeps
 * no previous key tries none.
 */

const updateConnectionMock = vi.fn(async () => ({}));
vi.mock('./store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
  findConnectionById: vi.fn(async () => null),
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const googleAccessTokenMock = vi.fn();
vi.mock('./google/auth.js', async () => {
  const real = await vi.importActual<typeof import('./google/auth.js')>('./google/auth.js');
  return { ...real, googleAccessToken: (a: unknown) => googleAccessTokenMock(a) };
});
const getSpreadsheetMock = vi.fn(async () => ({ title: 'Sheet', sheetTitles: ['A'] }));
vi.mock('./google/client.js', () => ({ getSpreadsheet: () => getSpreadsheetMock() }));

const { sentryAdapter } = await import('./sentry/adapter.js');
const { postmanAdapter } = await import('./postman/adapter.js');
const { epodsystemAdapter } = await import('./epodsystem/adapter.js');
const { googleAdapter } = await import('./google/adapter.js');
const { GoogleAuthError } = await import('./google/types.js');
const { rocketChatAdapter } = await import('./rocketchat/adapter.js');
const { coolifyAdapter } = await import('./coolify/adapter.js');

const UNTIL = new Date(Date.now() + 3_600_000).toISOString();
const originalFetch = globalThis.fetch;

/** A provider answering only the key named `works`, as each reads its key. */
function answeringOnly(works: string, ok: unknown) {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const sent = [h.get('authorization'), h.get('x-api-key')].join(' ');
    return sent.includes(works)
      ? new Response(JSON.stringify(ok), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('{"error":"unauthorized"}', { status: 401 });
  }) as unknown as typeof fetch;
}

function ctx(secrets: Record<string, unknown>, config: Record<string, unknown> = {}) {
  return {
    projectId: 'p-1',
    connectionId: 'conn-1',
    bindingId: 'bind-1',
    environment: 'live',
    config,
    secrets,
    // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics resolved at registration
  } as any;
}

beforeEach(() => {
  updateConnectionMock.mockClear();
  getSpreadsheetMock.mockClear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SENTRY = { host: 'https://sentry.example' };

describe('Sentry, which keeps the previous key for its own calls', () => {
  const secrets = {
    authToken: 'new-wrong',
    previousAuthToken: 'old-good',
    previousTokenExpiresAt: UNTIL,
  };

  it('answers Needs re-auth where only the previous key works, saying until when it is used', async () => {
    answeringOnly('old-good', [{ id: '1', slug: 'org', name: 'Org' }]);
    const res = await sentryAdapter.healthcheck(ctx(secrets, SENTRY));
    expect(res.status).toBe('needs_reauth');
    expect(res.message).toMatch(
      /^Sentry refused the new key\. Forge is still using the previous key until \d{1,2} \w+ \d{4}, \d{2}:\d{2} UTC\.$/,
    );
    expect(updateConnectionMock).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('answers Connected where the new key works', async () => {
    answeringOnly('new-wrong', [{ id: '1', slug: 'org', name: 'Org' }]);
    expect((await sentryAdapter.healthcheck(ctx(secrets, SENTRY))).status).toBe('ok');
  });

  // Consult finding at 068fc82: a previous-key probe that failed outright turned the verdict into an
  // error, so the new key's refusal was never said.
  it.each([
    ['cannot connect', () => Promise.reject(new TypeError('fetch failed'))],
    ['answers what is not JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
  ])("keeps the new key refused where the previous key's probe %s", async (_what, previous) => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
      new Headers(init?.headers).get('authorization')?.includes('new-wrong')
        ? new Response('{}', { status: 401 })
        : previous(),
    ) as unknown as typeof fetch;
    const res = await sentryAdapter.healthcheck(ctx(secrets, SENTRY));
    expect(res.status).toBe('needs_reauth');
    expect(res.message).not.toMatch(/previous key/);
  });

  it('answers the refusal alone where neither key works', async () => {
    answeringOnly('nobody', []);
    const res = await sentryAdapter.healthcheck(ctx(secrets, SENTRY));
    expect(res.status).toBe('needs_reauth');
    expect(res.message).not.toMatch(/previous key/);
  });
});

// Coolify's check is said of the server at the saved address, as the address is the person's own.
describe('Coolify, which keeps the previous token for its own calls', () => {
  const secrets = { apiToken: 'cf-new', previousApiToken: 'cf-old', previousTokenExpiresAt: UNTIL };
  const COOLIFY = {
    baseUrl: 'https://coolify.example',
    targets: [{ id: 't-1', label: 'App', resourceUuid: 'res-1' }],
  };

  it('answers Needs re-auth where only the previous token is accepted', async () => {
    answeringOnly('cf-old', [{ uuid: 'res-1', name: 'app' }]);
    const res = await coolifyAdapter.healthcheck(ctx(secrets, COOLIFY));
    expect(res.status).toBe('needs_reauth');
    expect(res.message).toMatch(
      /^The server at coolify\.example refused the new key\. Forge is still using the previous key until .+ UTC\.$/,
    );
    expect(updateConnectionMock).toHaveBeenCalledWith(
      'conn-1',
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('keeps the new token refused where the previous token cannot connect', async () => {
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) =>
      new Headers(init?.headers).get('authorization') === 'Bearer cf-new'
        ? new Response('{}', { status: 401 })
        : Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;
    const res = await coolifyAdapter.healthcheck(ctx(secrets, COOLIFY));
    expect(res.status).toBe('needs_reauth');
    expect(res.message).not.toMatch(/previous key|could not be reached|fetch failed/);
  });

  it('answers Connected where the new token is accepted', async () => {
    answeringOnly('cf-new', [{ uuid: 'res-1', name: 'app' }]);
    expect((await coolifyAdapter.healthcheck(ctx(secrets, COOLIFY))).status).toBe('ok');
  });
});

describe('Postman and Epodsystem, which keep no previous key', () => {
  it("Postman's check never passes on a key it was not given", async () => {
    answeringOnly('old-good', { user: { id: 1, username: 'u' } });
    const res = await postmanAdapter.healthcheck(
      ctx({ apiKey: 'new-wrong', previousApiKey: 'old-good', previousTokenExpiresAt: UNTIL }),
    );
    expect(res.status).toBe('needs_reauth');
  });

  it("Epodsystem's check never passes on a key it was not given", async () => {
    answeringOnly('old-good', { data: { apiKeyContext: { stores: [] } } });
    const res = await epodsystemAdapter.healthcheck(
      ctx(
        { apiKey: 'new-wrong', previousApiKey: 'old-good', previousTokenExpiresAt: UNTIL },
        { baseUrl: 'https://epod.example' },
      ),
    );
    expect(res.status).toBe('needs_reauth');
  });
});

describe('Google, which signs in with the previous key where it refuses the new one', () => {
  const key = (email: string) =>
    JSON.stringify({
      type: 'service_account',
      client_email: email,
      private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
      project_id: 'p',
    });

  it('answers Needs re-auth where only the previous key signs in', async () => {
    googleAccessTokenMock.mockImplementation(async (a: { serviceAccountJson: string }) => {
      if (a.serviceAccountJson.includes('new@'))
        throw new GoogleAuthError(400, 'rejected', 'invalid_grant');
      return { token: 't' };
    });
    const res = await googleAdapter.healthcheck(
      ctx(
        {
          serviceAccountJson: key('new@x.iam'),
          previousServiceAccountJson: key('old@x.iam'),
          previousTokenExpiresAt: UNTIL,
        },
        { defaultSpreadsheetId: 's-1' },
      ),
    );
    expect(res.status).toBe('needs_reauth');
    expect(res.message).toMatch(
      /^Google refused the new key\. Forge is still using the previous key until /,
    );
    expect(getSpreadsheetMock).not.toHaveBeenCalled();
  });

  it('keeps the new key refused where the previous key cannot sign in either', async () => {
    googleAccessTokenMock.mockImplementation(async (a: { serviceAccountJson: string }) => {
      if (a.serviceAccountJson.includes('new@'))
        throw new GoogleAuthError(400, 'rejected', 'invalid_grant');
      throw new TypeError('fetch failed');
    });
    const res = await googleAdapter.healthcheck(
      ctx(
        {
          serviceAccountJson: key('new@x.iam'),
          previousServiceAccountJson: key('old@x.iam'),
          previousTokenExpiresAt: UNTIL,
        },
        { defaultSpreadsheetId: 's-1' },
      ),
    );
    expect(res.status).toBe('needs_reauth');
    expect(res.message).not.toMatch(/previous key|fetch failed/);
  });
});

// ISS-1421 r20 — judge-82: Rocket.Chat's check said "Rocket.Chat answered" of a server that is not
// Rocket.Chat, as Coolify's did before criterion 176.
describe("Rocket.Chat's check, said of the server at the saved address", () => {
  const rc = (status: number, body: string) => {
    globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;
    return rocketChatAdapter.healthcheck(
      ctx({ authToken: 't', userId: 'u' }, { serverUrl: 'https://chat.example/' }),
    );
  };

  it('names the server at the address for an answer that is not a 2xx', async () => {
    const res = await rc(404, 'not found');
    expect(res.message).toBe(
      'The server at chat.example answered HTTP 404 when asked who the bot is.',
    );
  });

  it('says a server that names no bot may not be Rocket.Chat', async () => {
    const res = await rc(200, '<html>hello</html>');
    expect(res.message).toBe(
      'The server at chat.example answered, but did not say who the bot is, so it may not be Rocket.Chat.',
    );
  });

  it('never says "Rocket.Chat answered"', async () => {
    for (const [status, body] of [
      [404, ''],
      [200, '{}'],
      [401, ''],
    ] as const)
      expect((await rc(status, body)).message).not.toMatch(
        /Rocket\.Chat answered|Rocket\.Chat refused/,
      );
  });
});
