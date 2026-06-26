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

const { applySentryMcpServers, resolveSentryMcpEntry, buildSentryMcpEntry } = await import(
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
  decryptConnectionSecretsMock.mockReturnValueOnce({ authToken: 'sntryu_secret_token_123456' });
}

beforeEach(() => {
  vi.clearAllMocks();
  listBindingsMock.mockReset();
  decryptConnectionSecretsMock.mockReset();
});

describe('buildSentryMcpEntry', () => {
  it('renders the stdio @sentry/mcp-server entry with token + host env', () => {
    const entry = buildSentryMcpEntry(
      { host: 'logs.canawan.com', environment: 'prod' },
      'sntryu_abc',
    );
    expect(entry).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@sentry/mcp-server@latest'],
      env: { SENTRY_ACCESS_TOKEN: 'sntryu_abc', SENTRY_HOST: 'logs.canawan.com' },
      enabled: true,
    });
  });

  it('strips a scheme + trailing slash from the host', () => {
    const entry = buildSentryMcpEntry(
      { host: 'https://sentry.io/', environment: 'prod' },
      'sntryu_abc',
    );
    expect((entry.env as Record<string, string>).SENTRY_HOST).toBe('sentry.io');
  });
});

describe('resolveSentryMcpEntry', () => {
  it('returns the rendered entry when an active integration exists', async () => {
    mockActiveRow({ host: 'logs.canawan.com' });
    const entry = await resolveSentryMcpEntry(PROJECT_ID);
    expect(entry).not.toBeNull();
    expect(entry?.type).toBe('stdio');
    expect((entry?.env as Record<string, string>).SENTRY_ACCESS_TOKEN).toBe(
      'sntryu_secret_token_123456',
    );
    expect((entry?.env as Record<string, string>).SENTRY_HOST).toBe('logs.canawan.com');
  });

  it('returns null when no active integration exists', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const entry = await resolveSentryMcpEntry(PROJECT_ID);
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
    const entry = await resolveSentryMcpEntry(PROJECT_ID);
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
    const entry = await resolveSentryMcpEntry(PROJECT_ID);
    expect(entry).toBeNull();
  });
});

describe('applySentryMcpServers (ISS-581 — opt-in gating)', () => {
  it('does NOT inject when sentinel is absent (no sentry key in current)', async () => {
    const existing = { other: { type: 'stdio' } };
    const merged = await applySentryMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
    expect(listBindingsMock).not.toHaveBeenCalled();
  });

  it('does NOT inject when current is null (no sentinel declared)', async () => {
    const merged = await applySentryMcpServers(PROJECT_ID, null);
    expect(merged).toBeNull();
    expect(listBindingsMock).not.toHaveBeenCalled();
  });

  it('injects and strips sentinel when sentry: true + active integration', async () => {
    mockActiveRow({ host: 'logs.canawan.com' });
    const merged = await applySentryMcpServers(PROJECT_ID, { sentry: true });
    expect(merged).not.toBeNull();
    expect(Object.keys(merged ?? {})).toEqual(['sentry']);
    expect((merged?.sentry as Record<string, unknown>)?.type).toBe('stdio');
  });

  it('merges sentry spec alongside other entries when sentinel present', async () => {
    mockActiveRow({ host: 'logs.canawan.com' });
    const merged = await applySentryMcpServers(PROJECT_ID, { other: { type: 'http' }, sentry: true });
    expect(merged).toMatchObject({ other: { type: 'http' }, sentry: { type: 'stdio' } });
  });

  it('strips sentinel and returns null when no active integration and no other entries', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const merged = await applySentryMcpServers(PROJECT_ID, { sentry: true });
    expect(merged).toBeNull();
  });

  it('strips sentinel but preserves other entries when no active integration', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const merged = await applySentryMcpServers(PROJECT_ID, { sentry: true, other: { type: 'stdio' } });
    expect(merged).toEqual({ other: { type: 'stdio' } });
    expect(merged?.sentry).toBeUndefined();
  });

  // ISS-524 / EMPTY-singleton no-leak
  it('does not mutate the passed override (dispatch-twice no-leak)', async () => {
    mockActiveRow({ host: 'logs.canawan.com' });
    const shared = { base: { type: 'http' }, sentry: true } as Record<string, unknown>;
    const merged = await applySentryMcpServers(PROJECT_ID, shared);
    expect(merged).not.toBe(shared);
    expect((merged?.sentry as Record<string, unknown>)?.type).toBe('stdio');

    // Second dispatch with NO active integration — sentry sentinel stripped.
    listBindingsMock.mockResolvedValueOnce([]);
    const other = { base: { type: 'http' }, sentry: true };
    const merged2 = await applySentryMcpServers(PROJECT_ID, other);
    expect(merged2?.sentry).toBeUndefined();
    expect(merged2?.base).toEqual({ type: 'http' });
  });

  it('leaves an existing sentry spec object untouched (no double-inject)', async () => {
    const existing = { sentry: { type: 'stdio', command: 'npx', args: [], env: {}, enabled: true } };
    const merged = await applySentryMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
    expect(listBindingsMock).not.toHaveBeenCalled();
  });
});
