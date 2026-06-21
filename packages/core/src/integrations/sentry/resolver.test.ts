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

describe('applySentryMcpServers', () => {
  it('adds the sentry entry to a null override (project-default inject)', async () => {
    mockActiveRow({ host: 'logs.canawan.com' });
    const merged = await applySentryMcpServers(PROJECT_ID, null);
    expect(merged).not.toBeNull();
    expect(Object.keys(merged ?? {})).toEqual(['sentry']);
  });

  it('merges sentry alongside an existing override without clobbering it', async () => {
    mockActiveRow({ host: 'logs.canawan.com' });
    const merged = await applySentryMcpServers(PROJECT_ID, { other: { type: 'stdio' } });
    expect(merged).toMatchObject({ other: { type: 'stdio' }, sentry: { type: 'stdio' } });
  });

  it('leaves the override unchanged when there is no active integration', async () => {
    listBindingsMock.mockResolvedValueOnce([]);
    const existing = { other: { type: 'stdio' } };
    const merged = await applySentryMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
  });

  // ISS-524 / EMPTY-singleton no-leak: two consecutive dispatches must each get
  // a FRESH override object — the resolver never mutates the caller's value, so
  // a second project's dispatch cannot inherit the first's sentry entry.
  it('does not mutate the passed override (dispatch-twice no-leak)', async () => {
    mockActiveRow({ host: 'logs.canawan.com' });
    const shared = Object.freeze({ base: { type: 'http' } }) as Record<string, unknown>;
    const merged = await applySentryMcpServers(PROJECT_ID, shared);
    expect(merged).not.toBe(shared);
    expect(shared.sentry).toBeUndefined();
    expect(merged).toMatchObject({ base: { type: 'http' }, sentry: { type: 'stdio' } });

    // Second dispatch with NO active integration leaves a different override
    // untouched — proving no cross-dispatch state was retained.
    listBindingsMock.mockResolvedValueOnce([]);
    const other = { base: { type: 'http' } };
    expect(await applySentryMcpServers(PROJECT_ID, other)).toBe(other);
  });
});
