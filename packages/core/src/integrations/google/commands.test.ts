import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listBindingsForProjectMock = vi.fn();
// A whole mock rather than a partial one: the real module imports `db/client`,
// which parses the server env at import time, and nothing in these cases needs
// a database. `effectiveConfig` is restated because it is pure and three cases
// turn on the binding-over-connection overlay it performs.
vi.mock('../store.js', () => ({
  listBindingsForProject: (...a: unknown[]) => listBindingsForProjectMock(...(a as [])),
  decryptConnectionSecrets: (connection: { secretsPlain?: Record<string, unknown> }) =>
    connection.secretsPlain ?? {},
  effectiveConfig: (pair: {
    connection: { config?: Record<string, unknown> };
    binding: { config?: Record<string, unknown> };
  }) => ({ ...(pair.connection.config ?? {}), ...(pair.binding.config ?? {}) }),
}));

const {
  GoogleCommandError,
  googleSheetsInfo,
  googleSheetsRead,
  googleSheetsUpdate,
  listGoogleIntegrations,
  resolveGoogleBinding,
} = await import('./commands.js');
const { __resetGoogleTokenCache } = await import('./auth.js');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const KEY_FILE = JSON.stringify({
  type: 'service_account',
  private_key: privateKey,
  client_email: 'forge@forge-sheets-1.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
});

const PROJECT = '55555555-5555-4555-8555-555555555555';
const DEFAULT_SHEET = '1DefaultSheetId';
const OTHER_SHEET = '1OtherSheetId';

const originalFetch = globalThis.fetch;

/** One binding+connection row, in whatever state the case is about. */
function row(opts: {
  bindingActive?: boolean;
  connectionActive?: boolean;
  bindingConfig?: Record<string, unknown>;
  connectionConfig?: Record<string, unknown>;
  secrets?: Record<string, unknown> | null;
  createdAt?: Date;
  id?: string;
}) {
  return {
    binding: {
      id: opts.id ?? 'bind-1',
      connectionId: 'conn-1',
      projectId: PROJECT,
      provider: 'google',
      environment: 'prod',
      config: opts.bindingConfig ?? { defaultSpreadsheetId: DEFAULT_SHEET },
      active: opts.bindingActive ?? true,
      createdAt: opts.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    },
    connection: {
      id: 'conn-1',
      provider: 'google',
      config: opts.connectionConfig ?? { clientEmail: 'forge@forge-sheets-1.iam.gserviceaccount.com' },
      active: opts.connectionActive ?? true,
      lastHealthStatus: 'ok',
      secretsPlain: opts.secrets === null ? {} : (opts.secrets ?? { serviceAccountJson: KEY_FILE }),
    },
    // biome-ignore lint/suspicious/noExplicitAny: a row fixture, not the full drizzle shape
  } as any;
}

function wireGoogle() {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'ya29.tok', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ properties: { title: 'Roster' }, sheets: [], range: 'A1', values: [['x']] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { urls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetGoogleTokenCache();
  vi.clearAllMocks();
});

beforeEach(() => {
  listBindingsForProjectMock.mockResolvedValue([]);
});

describe('no Google connection at all (criteria 16, 17)', () => {
  it('refuses by a message naming that as the cause', async () => {
    await expect(googleSheetsRead({ projectId: PROJECT, range: 'A1' })).rejects.toMatchObject({
      code: 'NO_CONNECTION',
    });
    await googleSheetsRead({ projectId: PROJECT, range: 'A1' }).catch((err: Error) => {
      expect(err.message).toContain('no Google connection bound');
    });
  });

  it('sends nothing to Google', async () => {
    const g = wireGoogle();
    await googleSheetsRead({ projectId: PROJECT, range: 'A1' }).catch(() => {});
    expect(g.urls).toEqual([]);
  });

  it('a binding of another provider is not a Google binding', async () => {
    listBindingsForProjectMock.mockResolvedValue([
      { binding: { provider: 'coolify', active: true }, connection: { active: true } },
    ]);
    await expect(googleSheetsRead({ projectId: PROJECT, range: 'A1' })).rejects.toMatchObject({
      code: 'NO_CONNECTION',
    });
  });
});

describe('the binding exists and is switched off (criteria 18, 19)', () => {
  it('is a different refusal from having none — which is the whole point', async () => {
    listBindingsForProjectMock.mockResolvedValue([row({ bindingActive: false })]);
    const err = await googleSheetsRead({ projectId: PROJECT, range: 'A1' }).catch(
      (e: InstanceType<typeof GoogleCommandError>) => e,
    );
    expect(err).toMatchObject({ code: 'BINDING_DISABLED' });
    expect((err as Error).message).toContain('switched off for this project');
    expect((err as Error).message).not.toContain('no Google connection bound');
  });

  it('names the credential rather than the project when the CONNECTION is off', async () => {
    listBindingsForProjectMock.mockResolvedValue([row({ connectionActive: false })]);
    await googleSheetsRead({ projectId: PROJECT, range: 'A1' }).catch((e: Error) => {
      expect(e.message).toContain('every project sharing it');
    });
  });

  it('sends nothing to Google', async () => {
    const g = wireGoogle();
    listBindingsForProjectMock.mockResolvedValue([row({ bindingActive: false })]);
    await googleSheetsRead({ projectId: PROJECT, range: 'A1' }).catch(() => {});
    expect(g.urls).toEqual([]);
  });

  it('a live binding beside a disabled one is used rather than refused', async () => {
    listBindingsForProjectMock.mockResolvedValue([
      row({ id: 'bind-off', bindingActive: false }),
      row({ id: 'bind-on', createdAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    const pair = await resolveGoogleBinding(PROJECT);
    expect(pair.binding.id).toBe('bind-on');
  });

  it('two live bindings resolve oldest-first, so adding one never flips the pick', async () => {
    listBindingsForProjectMock.mockResolvedValue([
      row({ id: 'bind-new', createdAt: new Date('2026-05-01T00:00:00Z') }),
      row({ id: 'bind-old', createdAt: new Date('2026-01-01T00:00:00Z') }),
    ]);
    expect((await resolveGoogleBinding(PROJECT)).binding.id).toBe('bind-old');
  });
});

describe('which spreadsheet (criteria 21, 22, 23)', () => {
  it('a caller naming none uses the binding default', async () => {
    const g = wireGoogle();
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    await googleSheetsRead({ projectId: PROJECT, range: 'Sheet1!A1' });
    expect(g.urls.some((u) => u.includes(encodeURIComponent(DEFAULT_SHEET)))).toBe(true);
  });

  it('a caller naming one overrides the default', async () => {
    const g = wireGoogle();
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    await googleSheetsRead({ projectId: PROJECT, spreadsheetId: OTHER_SHEET, range: 'Sheet1!A1' });
    expect(g.urls.some((u) => u.includes(encodeURIComponent(OTHER_SHEET)))).toBe(true);
    expect(g.urls.some((u) => u.includes(encodeURIComponent(DEFAULT_SHEET)))).toBe(false);
  });

  it('neither named nor declared is refused by name, before any request to Google', async () => {
    const g = wireGoogle();
    listBindingsForProjectMock.mockResolvedValue([row({ bindingConfig: {} })]);
    const err = await googleSheetsRead({ projectId: PROJECT, range: 'A1' }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'NO_SPREADSHEET' });
    expect((err as Error).message).toContain('declares no default');
    expect(g.urls).toEqual([]);
  });

  it('the binding default beats a connection-tier value of the same name', async () => {
    const g = wireGoogle();
    listBindingsForProjectMock.mockResolvedValue([
      row({
        bindingConfig: { defaultSpreadsheetId: DEFAULT_SHEET },
        connectionConfig: { defaultSpreadsheetId: OTHER_SHEET },
      }),
    ]);
    await googleSheetsRead({ projectId: PROJECT, range: 'A1' });
    expect(g.urls.some((u) => u.includes(encodeURIComponent(DEFAULT_SHEET)))).toBe(true);
  });
});

describe('Google rejecting the account (criterion 20)', () => {
  it('is a refusal naming the account, with no success payload', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      throw new Error('the Sheets API must not be reached once the mint has failed');
    }) as unknown as typeof fetch;
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    const err = await googleSheetsRead({ projectId: PROJECT, range: 'A1' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'ACCOUNT_REJECTED' });
    expect((err as Error).message).toContain('service-account credential');
  });

  it('a connection holding no key at all is the same refusal, not an empty read', async () => {
    listBindingsForProjectMock.mockResolvedValue([row({ secrets: null })]);
    await expect(googleSheetsRead({ projectId: PROJECT, range: 'A1' })).rejects.toMatchObject({
      code: 'ACCOUNT_REJECTED',
    });
  });

  it('Google refusing the SHEET is a different code from refusing the account', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'ya29.tok', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 403 });
    }) as unknown as typeof fetch;
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    await expect(googleSheetsRead({ projectId: PROJECT, range: 'A1' })).rejects.toMatchObject({
      code: 'SHEETS_REFUSED',
    });
  });
});

describe('the commands themselves', () => {
  it('info returns the title and tabs of the resolved sheet', async () => {
    wireGoogle();
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    await expect(googleSheetsInfo({ projectId: PROJECT })).resolves.toMatchObject({
      spreadsheetId: DEFAULT_SHEET,
      title: 'Roster',
    });
  });

  it('update writes to the resolved sheet', async () => {
    const g = wireGoogle();
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    await googleSheetsUpdate({ projectId: PROJECT, range: 'Sheet1!A1', values: [['x']] });
    expect(g.urls.some((u) => u.includes('valueInputOption=USER_ENTERED'))).toBe(true);
  });

  it('list reports a disabled binding as present and off, never as absent', async () => {
    listBindingsForProjectMock.mockResolvedValue([row({ bindingActive: false })]);
    const out = await listGoogleIntegrations(PROJECT);
    expect(out.integrations).toHaveLength(1);
    expect(out.integrations[0]).toMatchObject({
      active: false,
      defaultSpreadsheetId: DEFAULT_SHEET,
      clientEmail: 'forge@forge-sheets-1.iam.gserviceaccount.com',
    });
  });

  it('list carries no key material', async () => {
    listBindingsForProjectMock.mockResolvedValue([row({})]);
    expect(JSON.stringify(await listGoogleIntegrations(PROJECT))).not.toContain('PRIVATE KEY');
  });
});
