import { beforeEach, describe, expect, it, vi } from 'vitest';

// The resolver reads via the connection/binding store helpers.
const listBindingsMock = vi.fn();
const decryptConnectionSecretsMock = vi.fn();
vi.mock('../store.js', () => ({
  listActiveBindingsForProjectProvider: (...a: unknown[]) => listBindingsMock(...(a as [])),
  decryptConnectionSecrets: (...a: unknown[]) => decryptConnectionSecretsMock(...(a as [])),
  // Real overlay semantics so config flows through to the rendered entry.
  effectiveConfig: (pair: { connection: { config?: object }; binding: { config?: object } }) => ({
    ...(pair.connection.config ?? {}),
    ...(pair.binding.config ?? {}),
  }),
}));

const { applyPostmanMcpServers, resolvePostmanMcpEntry, buildPostmanMcpEntry } = await import(
  './resolver.js'
);

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function mockActiveRow(config: Record<string, unknown>) {
  listBindingsMock.mockResolvedValueOnce([
    {
      binding: { id: 'bind-1', projectId: PROJECT_ID, config: {} },
      connection: { id: 'conn-1', config, secretsEnc: Buffer.from('enc') },
    },
  ]);
  decryptConnectionSecretsMock.mockReturnValueOnce({ apiKey: 'PMAK-secret-key-123456' });
}

beforeEach(() => {
  vi.clearAllMocks();
  listBindingsMock.mockReset();
  decryptConnectionSecretsMock.mockReset();
});

describe('buildPostmanMcpEntry', () => {
  it('US minimal → mcp.postman.com/minimal + Bearer + enabled', () => {
    const entry = buildPostmanMcpEntry(
      { workspaceName: 'Forge Integration', region: 'us', mode: 'minimal', environment: 'prod' },
      'PMAK-abc',
    );
    expect(entry).toEqual({
      type: 'http',
      url: 'https://mcp.postman.com/minimal',
      headers: { Authorization: 'Bearer PMAK-abc' },
      enabled: true,
    });
  });

  it('EU region swaps the host to mcp.eu.postman.com', () => {
    const entry = buildPostmanMcpEntry(
      { workspaceName: 'W', region: 'eu', mode: 'minimal', environment: 'prod' },
      'PMAK-abc',
    );
    expect(entry.url).toBe('https://mcp.eu.postman.com/minimal');
  });

  it('full mode uses the /mcp path', () => {
    const entry = buildPostmanMcpEntry(
      { workspaceName: 'W', region: 'us', mode: 'full', environment: 'prod' },
      'PMAK-abc',
    );
    expect(entry.url).toBe('https://mcp.postman.com/mcp');
  });
});

describe('resolvePostmanMcpEntry', () => {
  it('returns the rendered entry when an active integration exists', async () => {
    mockActiveRow({ workspaceName: 'Forge Integration', region: 'us', mode: 'minimal' });
    const entry = await resolvePostmanMcpEntry(PROJECT_ID);
    expect(entry).not.toBeNull();
    expect(entry?.url).toBe('https://mcp.postman.com/minimal');
    expect((entry?.headers as Record<string, string>).Authorization).toBe(
      'Bearer PMAK-secret-key-123456',
    );
  });

  it('returns null when no active integration exists', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const entry = await resolvePostmanMcpEntry(PROJECT_ID);
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
    const entry = await resolvePostmanMcpEntry(PROJECT_ID);
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
    const entry = await resolvePostmanMcpEntry(PROJECT_ID);
    expect(entry).toBeNull();
  });
});

describe('applyPostmanMcpServers', () => {
  it('adds the postman entry to a null override (project-default inject)', async () => {
    mockActiveRow({ workspaceName: 'W', region: 'us', mode: 'minimal' });
    const merged = await applyPostmanMcpServers(PROJECT_ID, null);
    expect(merged).not.toBeNull();
    expect(Object.keys(merged ?? {})).toEqual(['postman']);
  });

  it('merges postman alongside an existing stage override without clobbering it', async () => {
    mockActiveRow({ workspaceName: 'W', region: 'us', mode: 'minimal' });
    const merged = await applyPostmanMcpServers(PROJECT_ID, { other: { type: 'stdio' } });
    expect(merged).toMatchObject({ other: { type: 'stdio' }, postman: { type: 'http' } });
  });

  it('leaves the override unchanged when there is no active integration', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const existing = { other: { type: 'stdio' } };
    const merged = await applyPostmanMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
  });

  it('returns null override unchanged when there is no active integration', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const merged = await applyPostmanMcpServers(PROJECT_ID, null);
    expect(merged).toBeNull();
  });
});
