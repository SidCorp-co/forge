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

const {
  applyEpodsystemMcpServers,
  resolveEpodsystemMcpEntry,
  resolveEpodsystemMcpEntries,
  buildEpodsystemMcpEntry,
} = await import('./resolver.js');

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function mockRow(label: string, config: Record<string, unknown> = {}) {
  return {
    binding: { id: `bind-${label || 'default'}`, projectId: PROJECT_ID, config: {}, label },
    connection: { id: `conn-${label || 'default'}`, config, secretsEnc: Buffer.from('enc') },
  };
}

function mockActiveRow(config: Record<string, unknown> = {}, label = '') {
  listBindingsMock.mockResolvedValueOnce([mockRow(label, config)]);
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

describe('resolveEpodsystemMcpEntries (ISS-558 — N bindings)', () => {
  it('returns a single "epodsystem" entry for an unlabeled (default) binding', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow('')]);
    decryptConnectionSecretsMock.mockReturnValueOnce({ apiKey: 'crmk_key1' });

    const entries = await resolveEpodsystemMcpEntries(PROJECT_ID);
    expect(Object.keys(entries)).toEqual(['epodsystem']);
    expect((entries.epodsystem?.headers as Record<string, string>).Authorization).toBe(
      'Bearer crmk_key1',
    );
  });

  it('returns "epodsystem_<slug>" for a labeled binding (dashes→underscores)', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow('partner-a')]);
    decryptConnectionSecretsMock.mockReturnValueOnce({ apiKey: 'crmk_key2' });

    const entries = await resolveEpodsystemMcpEntries(PROJECT_ID);
    expect(Object.keys(entries)).toEqual(['epodsystem_partner_a']);
  });

  it('returns N entries for N active bindings', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow(''), mockRow('store-b'), mockRow('store-c')]);
    decryptConnectionSecretsMock
      .mockReturnValueOnce({ apiKey: 'crmk_key1' })
      .mockReturnValueOnce({ apiKey: 'crmk_key2' })
      .mockReturnValueOnce({ apiKey: 'crmk_key3' });

    const entries = await resolveEpodsystemMcpEntries(PROJECT_ID);
    expect(Object.keys(entries).sort()).toEqual(['epodsystem', 'epodsystem_store_b', 'epodsystem_store_c']);
  });

  it('skips a binding whose key cannot be decrypted — others still inject', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow(''), mockRow('store-b')]);
    decryptConnectionSecretsMock
      .mockImplementationOnce(() => { throw new Error('bad key'); })
      .mockReturnValueOnce({ apiKey: 'crmk_good' });

    const entries = await resolveEpodsystemMcpEntries(PROJECT_ID);
    expect(Object.keys(entries)).toEqual(['epodsystem_store_b']);
    expect((entries.epodsystem_store_b?.headers as Record<string, string>).Authorization).toBe(
      'Bearer crmk_good',
    );
  });

  it('skips a binding with no secretsEnc', async () => {
    listBindingsMock.mockResolvedValueOnce([
      { binding: { id: 'bind-1', projectId: PROJECT_ID, config: {}, label: '' },
        connection: { id: 'conn-1', config: {}, secretsEnc: null } },
    ]);

    const entries = await resolveEpodsystemMcpEntries(PROJECT_ID);
    expect(Object.keys(entries)).toHaveLength(0);
  });

  it('returns empty record when no active integrations', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const entries = await resolveEpodsystemMcpEntries(PROJECT_ID);
    expect(entries).toEqual({});
  });

  it('returns empty record (does not throw) when DB lookup fails', async () => {
    listBindingsMock.mockRejectedValueOnce(new Error('connection refused'));
    const entries = await resolveEpodsystemMcpEntries(PROJECT_ID);
    expect(entries).toEqual({});
  });
});

describe('resolveEpodsystemMcpEntry (compat — returns default entry)', () => {
  it('returns the rendered entry when an active integration exists', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow('', { environment: 'prod' })]);
    decryptConnectionSecretsMock.mockReturnValueOnce({ apiKey: 'crmk_secret_key_123456' });
    const entry = await resolveEpodsystemMcpEntry(PROJECT_ID);
    expect(entry).not.toBeNull();
    expect(entry?.url).toBe('https://mcp.epodsystem.com/mcp');
    expect((entry?.headers as Record<string, string>).Authorization).toBe(
      'Bearer crmk_secret_key_123456',
    );
  });

  it('returns null when no active integration exists', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const entry = await resolveEpodsystemMcpEntry(PROJECT_ID);
    expect(entry).toBeNull();
  });

  it('returns null when only labeled bindings exist (no default binding)', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow('store-a')]);
    decryptConnectionSecretsMock.mockReturnValueOnce({ apiKey: 'crmk_abc' });
    const entry = await resolveEpodsystemMcpEntry(PROJECT_ID);
    // resolveEpodsystemMcpEntry returns entries.epodsystem — null when no default
    expect(entry).toBeNull();
  });
});

describe('applyEpodsystemMcpServers (ISS-581 — opt-in gating)', () => {
  // ISS-581: sentinel ABSENT → NOT injected even when active integration exists.
  it('does NOT inject when sentinel is absent (no epodsystem key in current)', async () => {
    const existing = { postman: { type: 'http' } };
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
    expect(listBindingsMock).not.toHaveBeenCalled();
  });

  it('does NOT inject when current is null (no sentinel declared)', async () => {
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, null);
    expect(merged).toBeNull();
    expect(listBindingsMock).not.toHaveBeenCalled();
  });

  // ISS-581: sentinel PRESENT + active integration → specs injected, sentinel stripped.
  it('injects ALL active entries when epodsystem: true sentinel present', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow(''), mockRow('store-b')]);
    decryptConnectionSecretsMock
      .mockReturnValueOnce({ apiKey: 'crmk_key1' })
      .mockReturnValueOnce({ apiKey: 'crmk_key2' });

    const merged = await applyEpodsystemMcpServers(PROJECT_ID, { epodsystem: true });
    expect(merged).not.toBeNull();
    expect(Object.keys(merged ?? {}).sort()).toEqual(['epodsystem', 'epodsystem_store_b']);
    // sentinel is stripped — no `true` value remains
    expect((merged?.epodsystem as Record<string, unknown>)?.type).toBe('http');
  });

  it('merges epodsystem entries alongside existing entries when sentinel present', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow('')]);
    decryptConnectionSecretsMock.mockReturnValueOnce({ apiKey: 'crmk_key1' });

    const merged = await applyEpodsystemMcpServers(PROJECT_ID, {
      postman: { type: 'http' },
      epodsystem: true,
    });
    expect(merged).toMatchObject({
      postman: { type: 'http' },
      epodsystem: { type: 'http' },
    });
  });

  // ISS-581: sentinel PRESENT but no active integration → sentinel stripped, no inject.
  it('strips sentinel and returns null when no active integration and no other entries', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, { epodsystem: true });
    expect(merged).toBeNull();
  });

  it('strips sentinel but preserves other entries when no active integration', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, {
      epodsystem: true,
      other: { type: 'stdio' },
    });
    expect(merged).toEqual({ other: { type: 'stdio' } });
    expect(merged?.epodsystem).toBeUndefined();
  });

  it('does NOT mutate the caller object', async () => {
    listBindingsMock.mockResolvedValueOnce([mockRow('')]);
    decryptConnectionSecretsMock.mockReturnValueOnce({ apiKey: 'crmk_key1' });
    const shared = { epodsystem: true, postman: { type: 'http' } } as Record<string, unknown>;
    const first = await applyEpodsystemMcpServers(PROJECT_ID, shared);
    expect(first).not.toBe(shared);
    // original still has the sentinel
    expect(shared.epodsystem).toBe(true);
  });

  it('leaves override unchanged when it has no epodsystem* sentinel', async () => {
    const existing = { other: { type: 'stdio' } };
    const merged = await applyEpodsystemMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
    expect(listBindingsMock).not.toHaveBeenCalled();
  });
});
