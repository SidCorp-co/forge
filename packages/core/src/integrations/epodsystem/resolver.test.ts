import { beforeEach, describe, expect, it, vi } from 'vitest';

// The resolver reads via the connection/binding store helpers.
const listBindingsMock = vi.fn();
const decryptConnectionSecretsMock = vi.fn();
vi.mock('../store.js', () => ({
  listActiveBindingsForProjectProvider: (...a: unknown[]) => listBindingsMock(...(a as [])),
  decryptConnectionSecrets: (...a: unknown[]) => decryptConnectionSecretsMock(...(a as [])),
  effectiveConfig: (pair: { connection: { config?: object }; binding: { config?: object } }) => ({
    ...(pair.connection.config ?? {}),
    ...(pair.binding.config ?? {}),
  }),
}));

const { applyEpodsystemMcpServers, resolveEpodsystemMcpEntry, buildEpodsystemMcpEntry } =
  await import('./resolver.js');

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function mockActiveRow(config: Record<string, unknown>) {
  listBindingsMock.mockResolvedValueOnce([
    {
      binding: { id: 'bind-1', projectId: PROJECT_ID, config: {} },
      connection: { id: 'conn-1', config, secretsEnc: Buffer.from('enc') },
    },
  ]);
  decryptConnectionSecretsMock.mockReturnValueOnce({ apiKey: 'crmk_secret_key_123456' });
}

beforeEach(() => {
  vi.clearAllMocks();
  listBindingsMock.mockReset();
  decryptConnectionSecretsMock.mockReset();
});

describe('buildEpodsystemMcpEntry', () => {
  it('renders the global MCP host + Bearer + enabled', () => {
    const entry = buildEpodsystemMcpEntry(
      { endpoint: 'https://acme.epodsystem.com', environment: 'prod' },
      'crmk_abc',
    );
    expect(entry).toEqual({
      type: 'http',
      url: 'https://mcp.epodsystem.com/mcp',
      headers: { Authorization: 'Bearer crmk_abc' },
      enabled: true,
    });
  });
});

describe('resolveEpodsystemMcpEntry', () => {
  it('returns the rendered entry when an active integration exists', async () => {
    mockActiveRow({ endpoint: 'https://acme.epodsystem.com', environment: 'prod' });
    const entry = await resolveEpodsystemMcpEntry(PROJECT_ID);
    expect(entry).not.toBeNull();
    expect(entry?.url).toBe('https://mcp.epodsystem.com/mcp');
    expect((entry?.headers as Record<string, string>).Authorization).toBe(
      'Bearer crmk_secret_key_123456',
    );
  });

  it('returns null when no active integration exists (AC#6 drop-on-disable)', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const entry = await resolveEpodsystemMcpEntry(PROJECT_ID);
    expect(entry).toBeNull();
    expect(decryptConnectionSecretsMock).not.toHaveBeenCalled();
  });

  it('returns null when the connection has no secretsEnc', async () => {
    listBindingsMock.mockResolvedValueOnce([
      {
        binding: { id: 'bind-1', projectId: PROJECT_ID, config: {} },
        connection: { id: 'conn-1', config: {}, secretsEnc: null },
      },
    ]);
    const entry = await resolveEpodsystemMcpEntry(PROJECT_ID);
    expect(entry).toBeNull();
  });

  it('returns null (does not throw) when decrypt fails', async () => {
    listBindingsMock.mockResolvedValueOnce([
      {
        binding: { id: 'bind-1', projectId: PROJECT_ID, config: {} },
        connection: { id: 'conn-1', config: {}, secretsEnc: Buffer.from('enc') },
      },
    ]);
    decryptConnectionSecretsMock.mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    const entry = await resolveEpodsystemMcpEntry(PROJECT_ID);
    expect(entry).toBeNull();
  });
});

describe('applyEpodsystemMcpServers', () => {
  it('adds the epodsystem entry to a null override (project-default inject)', async () => {
    mockActiveRow({ endpoint: 'https://acme.epodsystem.com', environment: 'prod' });
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, null);
    expect(merged).not.toBeNull();
    expect(Object.keys(merged ?? {})).toEqual(['epodsystem']);
  });

  it('merges epodsystem alongside an existing override without clobbering it', async () => {
    mockActiveRow({ endpoint: 'https://acme.epodsystem.com', environment: 'prod' });
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, { postman: { type: 'http' } });
    expect(merged).toMatchObject({
      postman: { type: 'http' },
      epodsystem: { type: 'http' },
    });
  });

  it('does NOT leak the key onto a shared/previous override object (no cross-tenant bleed)', async () => {
    // First dispatch: active integration injects the key.
    mockActiveRow({ endpoint: 'https://acme.epodsystem.com', environment: 'prod' });
    const shared = { postman: { type: 'http' } };
    const first = await applyEpodsystemMcpServers(PROJECT_ID, shared);
    expect(first).not.toBe(shared); // new object, original untouched
    expect(shared).toEqual({ postman: { type: 'http' } }); // caller's object unmutated

    // Second dispatch (different project, no active integration): no inject,
    // and nothing from the first dispatch bleeds through.
    listBindingsMock.mockResolvedValueOnce([]);
    const second = await applyEpodsystemMcpServers(PROJECT_ID, shared);
    expect(second).toBe(shared);
    expect(second).toEqual({ postman: { type: 'http' } });
  });

  it('leaves the override unchanged when there is no active integration', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const existing = { other: { type: 'stdio' } };
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
  });

  it('returns null override unchanged when there is no active integration', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, null);
    expect(merged).toBeNull();
  });
});
