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

describe('applyPostmanMcpServers (ISS-581 — opt-in gating)', () => {
  // ISS-581: sentinel ABSENT → NOT injected even when active integration exists.
  it('does NOT inject when sentinel is absent (no postman key in current)', async () => {
    const existing = { other: { type: 'stdio' } };
    const merged = await applyPostmanMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
    expect(listBindingsMock).not.toHaveBeenCalled();
  });

  it('does NOT inject when current is null (no sentinel declared)', async () => {
    const merged = await applyPostmanMcpServers(PROJECT_ID, null);
    expect(merged).toBeNull();
    expect(listBindingsMock).not.toHaveBeenCalled();
  });

  // ISS-581: sentinel PRESENT + active integration → spec injected, sentinel stripped.
  it('injects and strips sentinel when postman: true + active integration', async () => {
    mockActiveRow({ workspaceName: 'W', region: 'us', mode: 'minimal' });
    const merged = await applyPostmanMcpServers(PROJECT_ID, { postman: true });
    expect(merged).not.toBeNull();
    expect(Object.keys(merged ?? {})).toEqual(['postman']);
    expect((merged?.postman as Record<string, unknown>)?.type).toBe('http');
  });

  it('merges postman spec alongside other entries when sentinel present', async () => {
    mockActiveRow({ workspaceName: 'W', region: 'us', mode: 'minimal' });
    const merged = await applyPostmanMcpServers(PROJECT_ID, {
      other: { type: 'stdio' },
      postman: true,
    });
    expect(merged).toMatchObject({ other: { type: 'stdio' }, postman: { type: 'http' } });
  });

  // ISS-581: sentinel PRESENT but no active integration → sentinel stripped, no inject.
  it('strips sentinel and returns null when no active integration and no other entries', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const merged = await applyPostmanMcpServers(PROJECT_ID, { postman: true });
    expect(merged).toBeNull();
  });

  it('strips sentinel but preserves other entries when no active integration', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const merged = await applyPostmanMcpServers(PROJECT_ID, { postman: true, other: { type: 'stdio' } });
    expect(merged).toEqual({ other: { type: 'stdio' } });
    expect(merged?.postman).toBeUndefined();
  });

  // Legacy: already-object postman entry (not a sentinel) is left untouched.
  it('leaves an existing postman spec object untouched (no double-inject)', async () => {
    const existing = { postman: { type: 'http', url: 'https://existing', enabled: true } };
    const merged = await applyPostmanMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
    expect(listBindingsMock).not.toHaveBeenCalled();
  });
});
