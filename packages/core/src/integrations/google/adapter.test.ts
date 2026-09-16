import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateConnectionMock = vi.fn();
const findConnectionByIdMock = vi.fn();
vi.mock('../store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
  findConnectionById: (...a: unknown[]) => findConnectionByIdMock(...(a as [])),
}));

const { googleAdapter } = await import('./adapter.js');
const { __resetGoogleTokenCache, googleAccessToken } = await import('./auth.js');
const { SHEETS_READONLY_SCOPE } = await import('./scopes.js');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function keyFile(clientEmail = 'forge@forge-sheets-1.iam.gserviceaccount.com'): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'forge-sheets-1',
    private_key: privateKey,
    client_email: clientEmail,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

const CONN_ID = 'conn-google-adapter';
const BINDING_ID = 'bind-google-adapter';
const SHEET = '1RosterSheetId';

const originalFetch = globalThis.fetch;

interface Wiring {
  tokenStatus?: number;
  sheetsStatus?: number;
  title?: string;
}

/** Records every request so "no Sheets request was made" is an assertion rather
 *  than a hope. */
function wireGoogle(w: Wiring = {}) {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      if (w.tokenStatus && w.tokenStatus !== 200) {
        return new Response('{"error":"invalid_grant"}', { status: w.tokenStatus });
      }
      return new Response(JSON.stringify({ access_token: 'ya29.tok', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (w.sheetsStatus && w.sheetsStatus !== 200) {
      return new Response('{}', { status: w.sheetsStatus });
    }
    return new Response(
      JSON.stringify({
        properties: { title: w.title ?? 'Roster' },
        sheets: [{ properties: { title: 'Sheet1' } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return {
    urls,
    tokenCalls: () =>
      urls.filter((u) => u.startsWith('https://oauth2.googleapis.com/token')).length,
    sheetsCalls: () => urls.filter((u) => u.startsWith('https://sheets.googleapis.com/')).length,
  };
}

function buildCtx(
  secrets: Record<string, unknown>,
  config: Record<string, unknown> = { defaultSpreadsheetId: SHEET },
) {
  return {
    projectId: '44444444-4444-4444-8444-444444444444',
    connectionId: CONN_ID,
    bindingId: BINDING_ID,
    provider: 'google',
    // `providerCanDeploy('google')` is false, so every google binding is `service` and carries
    // no stage. The fixture said `environment: 'prod'` — a field the adapter context no longer
    // has — and the `as any` below is what hid that from the type checker.
    role: 'service',
    stages: [],
    config,
    secrets,
    integrationSecret: null,
    // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics resolved at registration
  } as any;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetGoogleTokenCache();
  vi.clearAllMocks();
});

beforeEach(() => {
  updateConnectionMock.mockResolvedValue({});
  // The CONNECTION's own stored config — deliberately not the binding overlay
  // the adapter context carries.
  findConnectionByIdMock.mockResolvedValue({ id: CONN_ID, config: { someExistingKey: 'kept' } });
});

describe('googleAdapter.healthcheck (criteria 10, 11, 12, 13)', () => {
  it('reads the bound spreadsheet with the token it minted and reports ok with the title', async () => {
    const g = wireGoogle({ title: 'Q4 roster' });
    const res = await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }));
    expect(res.status).toBe('ok');
    expect(res.message).toContain('Q4 roster');
    expect(res.message).toContain('forge@forge-sheets-1.iam.gserviceaccount.com');
    expect(g.tokenCalls()).toBe(1);
    expect(g.sheetsCalls()).toBe(1);
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'ok' }),
    );
  });

  it('writes the account identity back into config so the card can name it', async () => {
    wireGoogle();
    await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }));
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({
        config: {
          someExistingKey: 'kept',
          clientEmail: 'forge@forge-sheets-1.iam.gserviceaccount.com',
          projectId: 'forge-sheets-1',
        },
      }),
    );
  });

  it("does not promote this binding's default spreadsheet onto the shared credential", async () => {
    wireGoogle();
    await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }));
    const written = updateConnectionMock.mock.calls[0]?.[1] as { config: Record<string, unknown> };
    expect(written.config.defaultSpreadsheetId).toBeUndefined();
    expect(JSON.stringify(written.config)).not.toContain(SHEET);
  });

  it('nothing it returns carries the key', async () => {
    wireGoogle();
    const res = await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }));
    expect(JSON.stringify(res)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(res)).not.toContain('ya29.');
  });

  it('reports needs_reauth when Google refuses the assertion, and asks Sheets nothing', async () => {
    const g = wireGoogle({ tokenStatus: 400 });
    const res = await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }));
    expect(res.status).toBe('needs_reauth');
    expect(g.sheetsCalls()).toBe(0);
  });

  it('reports needs_scope when Google accepts the account and refuses the sheet', async () => {
    wireGoogle({ sheetsStatus: 403 });
    const res = await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }));
    expect(res.status).toBe('needs_scope');
    expect(res.message).toContain('share the sheet');
  });

  it('a 401 from Sheets is needs_reauth, never needs_scope', async () => {
    wireGoogle({ sheetsStatus: 401 });
    const res = await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }));
    expect(res.status).toBe('needs_reauth');
  });

  it('a missing key is an error naming it, not a silent ok', async () => {
    const g = wireGoogle();
    const res = await googleAdapter.healthcheck(buildCtx({}));
    expect(res.status).toBe('error');
    expect(g.tokenCalls()).toBe(0);
  });

  it('a valid account with no default spreadsheet is degraded, not ok', async () => {
    const g = wireGoogle();
    const res = await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }, {}));
    expect(res.status).toBe('degraded');
    expect(res.message).toContain('no default spreadsheet');
    expect(g.tokenCalls()).toBe(1);
    expect(g.sheetsCalls()).toBe(0);
  });

  it('falls back to a retained previous key inside the rotation window', async () => {
    const good = keyFile('rotated@forge-sheets-1.iam.gserviceaccount.com');
    let seenAssertions = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        seenAssertions += 1;
        const body = new URLSearchParams(String(init?.body ?? ''));
        const claims = JSON.parse(
          Buffer.from(String(body.get('assertion')).split('.')[1] ?? '', 'base64url').toString(),
        ) as { iss?: string };
        if (claims.iss === 'rotated@forge-sheets-1.iam.gserviceaccount.com') {
          return new Response(JSON.stringify({ access_token: 'ya29.tok', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      return new Response(JSON.stringify({ properties: { title: 'Roster' }, sheets: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const res = await googleAdapter.healthcheck(
      buildCtx({
        serviceAccountJson: keyFile('revoked@forge-sheets-1.iam.gserviceaccount.com'),
        previousServiceAccountJson: good,
        previousTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    expect(seenAssertions).toBe(2);
    expect(res.status).toBe('ok');
    expect(res.diagnostics?.usedPreviousCredential).toBe(true);
  });

  it('does not fall back once the rotation window has lapsed', async () => {
    const g = wireGoogle({ tokenStatus: 400 });
    const res = await googleAdapter.healthcheck(
      buildCtx({
        serviceAccountJson: keyFile(),
        previousServiceAccountJson: keyFile('old@forge-sheets-1.iam.gserviceaccount.com'),
        previousTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    expect(res.status).toBe('needs_reauth');
    expect(g.tokenCalls()).toBe(1);
  });
});

describe('test-connection mints fresh (criterion 7)', () => {
  it('does not reuse a cached token, so a replaced key is the one tested', async () => {
    const g = wireGoogle();
    // Warm the cache the way an earlier tool call would have.
    await googleAccessToken({
      connectionId: CONN_ID,
      serviceAccountJson: keyFile(),
      scope: SHEETS_READONLY_SCOPE,
    });
    expect(g.tokenCalls()).toBe(1);
    await googleAdapter.healthcheck(buildCtx({ serviceAccountJson: keyFile() }));
    expect(g.tokenCalls()).toBe(2);
  });
});

describe('the surfaces this provider does not have', () => {
  it('refuses an outbound dispatch by name instead of accepting and dropping it', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: exercising the refusal, not the signature
      googleAdapter.dispatchOutbound(buildCtx({}), {} as any),
    ).rejects.toThrow(/forge_google_sheets/);
  });

  it('refuses an inbound webhook by name', async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: exercising the refusal, not the signature
      googleAdapter.handleInbound(buildCtx({}), {} as any),
    ).rejects.toThrow(/not supported/);
  });

  it('declares no delivery log, no webhook and no env split', () => {
    expect(googleAdapter.capabilities).toEqual({
      canDispatch: false,
      canReceiveWebhook: false,
      injectsMcp: false,
      canDeploy: false,
      liveConfirmGate: false,
      hasDeliveryLog: false,
    });
  });
});
