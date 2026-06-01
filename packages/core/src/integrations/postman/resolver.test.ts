import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- db.select().from().where().limit() chain ---
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const decryptJson = vi.fn();
vi.mock('../vault.js', () => ({
  decryptJson: (buf: Buffer) => decryptJson(buf),
}));

const { applyPostmanMcpServers, resolvePostmanMcpEntry, buildPostmanMcpEntry } = await import(
  './resolver.js'
);

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function mockActiveRow(config: Record<string, unknown>) {
  selectLimit.mockResolvedValueOnce([
    { id: 'int-1', projectId: PROJECT_ID, config, secretsEnc: Buffer.from('enc') },
  ]);
  decryptJson.mockReturnValueOnce({ apiKey: 'PMAK-secret-key-123456' });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  decryptJson.mockReset();
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
    selectLimit.mockResolvedValueOnce([]);
    const entry = await resolvePostmanMcpEntry(PROJECT_ID);
    expect(entry).toBeNull();
    expect(decryptJson).not.toHaveBeenCalled();
  });

  it('returns null when the row has no secretsEnc', async () => {
    selectLimit.mockResolvedValueOnce([
      { id: 'int-1', projectId: PROJECT_ID, config: {}, secretsEnc: null },
    ]);
    const entry = await resolvePostmanMcpEntry(PROJECT_ID);
    expect(entry).toBeNull();
  });

  it('returns null (does not throw) when decrypt fails', async () => {
    selectLimit.mockResolvedValueOnce([
      { id: 'int-1', projectId: PROJECT_ID, config: {}, secretsEnc: Buffer.from('enc') },
    ]);
    decryptJson.mockImplementationOnce(() => {
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
    selectLimit.mockResolvedValueOnce([]);
    const existing = { other: { type: 'stdio' } };
    const merged = await applyPostmanMcpServers(PROJECT_ID, existing);
    expect(merged).toBe(existing);
  });

  it('returns null override unchanged when there is no active integration', async () => {
    selectLimit.mockResolvedValueOnce([]);
    const merged = await applyPostmanMcpServers(PROJECT_ID, null);
    expect(merged).toBeNull();
  });
});
