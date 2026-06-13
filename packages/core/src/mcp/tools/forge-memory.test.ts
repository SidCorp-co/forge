import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingUnavailableError } from '../../embeddings/index.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    EMBEDDINGS_MODEL: 'gemini-embedding',
  },
}));

const limit = vi.fn();
const where = vi.fn(() => ({ limit }));
// lib/authz.ts effectiveProjectRole chains TWO leftJoins before where().limit(1).
const leftJoin2 = vi.fn(() => ({ where }));
const leftJoin = vi.fn(() => ({ leftJoin: leftJoin2, where }));
const from = vi.fn(() => ({ where, leftJoin }));
const select = vi.fn(() => ({ from }));

vi.mock('../../db/client.js', () => ({
  db: { select },
}));

const runMemoryWriteMock = vi.fn();
const runMemorySearchMock = vi.fn();
const runMemoryGetMock = vi.fn();
const deleteMemoryMock = vi.fn();

vi.mock('../../memory/indexer.js', () => ({
  deleteMemory: (...args: unknown[]) => deleteMemoryMock(...args),
}));

vi.mock('../../memory/write-service.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../memory/write-service.js')>(
      '../../memory/write-service.js',
    );
  return {
    ...actual,
    runMemoryWrite: (input: unknown) => runMemoryWriteMock(input),
  };
});

vi.mock('../../memory/search-service.js', () => ({
  runMemorySearch: (input: unknown) => runMemorySearchMock(input),
  // forge-memory.ts imports this at module load for the `strategy` enum;
  // the mock must export it or the tool module throws on import.
  memorySearchStrategies: ['semantic', 'keyword', 'hybrid'] as const,
}));

vi.mock('../../memory/get-service.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../memory/get-service.js')>(
      '../../memory/get-service.js',
    );
  return {
    ...actual,
    runMemoryGet: (input: unknown) => runMemoryGetMock(input),
  };
});

const {
  forgeMemoryWriteTool,
  forgeMemorySearchTool,
  forgeMemoryGetTool,
  forgeMemoryDeleteTool,
} = await import('./forge-memory.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  machineId: null,
  gitCredentialRef: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

beforeEach(() => {
  limit.mockReset();
  runMemoryWriteMock.mockReset();
  runMemorySearchMock.mockReset();
  runMemoryGetMock.mockReset();
  deleteMemoryMock.mockReset();
});

describe('forge_memory.write tool', () => {
  it('exposes the correct name + JSON schema', () => {
    const tool = forgeMemoryWriteTool(fakeDevice);
    expect(tool.name).toBe('forge_memory.write');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        projectId: expect.any(Object),
        source: expect.any(Object),
        sourceRef: expect.any(Object),
        textContent: expect.any(Object),
      }),
    });
  });

  it('writes when the device owner is a project member', async () => {
    // 1st db.select: project ownership lookup → owner matches.
    limit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    runMemoryWriteMock.mockResolvedValueOnce({
      id: 'm-1',
      embeddedAt: new Date('2026-05-28T00:00:00Z'),
      truncated: false,
    });

    const tool = forgeMemoryWriteTool(fakeDevice);
    const r = await tool.handler({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'run:1/step:plan/attempt:1',
      textContent: 'plan handoff text',
      metadata: { run_id: 'run-1', step: 'plan', attempt: 1 },
    });

    expect(r).toMatchObject({ id: 'm-1', truncated: false });
    expect(runMemoryWriteMock).toHaveBeenCalledOnce();
  });

  it('rejects with FORBIDDEN when device owner is neither owner nor member', async () => {
    // owner mismatch + no membership row.
    limit
      .mockResolvedValueOnce([{ ownerId: 'other-owner' }])
      .mockResolvedValueOnce([]);

    const tool = forgeMemoryWriteTool(fakeDevice);
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        source: 'note',
        sourceRef: 'n-1',
        textContent: 't',
      }),
    ).rejects.toThrow(/FORBIDDEN/);

    expect(runMemoryWriteMock).not.toHaveBeenCalled();
  });

  it('surfaces embeddings outage with UNAVAILABLE prefix', async () => {
    limit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    runMemoryWriteMock.mockRejectedValueOnce(
      new EmbeddingUnavailableError('breaker open until 2026'),
    );

    const tool = forgeMemoryWriteTool(fakeDevice);
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        source: 'note',
        sourceRef: 'n-1',
        textContent: 't',
      }),
    ).rejects.toThrow(/^UNAVAILABLE: /);
  });

  it('rejects malformed input via Zod before any DB / embed call', async () => {
    const tool = forgeMemoryWriteTool(fakeDevice);
    await expect(
      tool.handler({
        projectId: 'not-a-uuid',
        source: 'note',
        sourceRef: 'n-1',
        textContent: 't',
      }),
    ).rejects.toThrow();
    expect(limit).not.toHaveBeenCalled();
    expect(runMemoryWriteMock).not.toHaveBeenCalled();
  });
});

describe('forge_memory.get tool', () => {
  it('exposes the correct name + schema with metadataFilter', () => {
    const tool = forgeMemoryGetTool(fakeDevice);
    expect(tool.name).toBe('forge_memory.get');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        projectId: expect.any(Object),
        metadataFilter: expect.any(Object),
        orderBy: expect.any(Object),
      }),
    });
  });

  it('returns rows + total when device owner is a member', async () => {
    limit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    runMemoryGetMock.mockResolvedValueOnce({
      rows: [{ id: 'm-1', projectId: PROJECT_ID, source: 'step_handoff' }],
      total: 1,
    });

    const tool = forgeMemoryGetTool(fakeDevice);
    const r = await tool.handler({
      projectId: PROJECT_ID,
      source: 'note',
      metadataFilter: { run_id: 'r-1', step: 'plan', attempt: 1 },
    });

    expect(r).toMatchObject({ total: 1, rows: expect.any(Array) });
    expect(runMemoryGetMock).toHaveBeenCalledOnce();
  });

  it('rejects non-member device with FORBIDDEN', async () => {
    limit
      .mockResolvedValueOnce([{ ownerId: 'other-owner' }])
      .mockResolvedValueOnce([]);

    const tool = forgeMemoryGetTool(fakeDevice);
    await expect(
      tool.handler({ projectId: PROJECT_ID }),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(runMemoryGetMock).not.toHaveBeenCalled();
  });
});

describe('forge_memory.delete tool', () => {
  it('returns {deleted:true} when a row was removed', async () => {
    limit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    deleteMemoryMock.mockResolvedValueOnce(1);

    const tool = forgeMemoryDeleteTool(fakeDevice);
    const r = await tool.handler({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'run:1/step:plan/attempt:1',
    });

    expect(r).toEqual({ deleted: true });
    expect(deleteMemoryMock).toHaveBeenCalledWith(
      PROJECT_ID,
      'note',
      'run:1/step:plan/attempt:1',
    );
  });

  it('returns {deleted:false} when no row matched (idempotent)', async () => {
    limit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    deleteMemoryMock.mockResolvedValueOnce(0);

    const tool = forgeMemoryDeleteTool(fakeDevice);
    const r = await tool.handler({
      projectId: PROJECT_ID,
      source: 'note',
      sourceRef: 'gone',
    });
    expect(r).toEqual({ deleted: false });
  });

  it('rejects non-member device with FORBIDDEN', async () => {
    limit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);

    const tool = forgeMemoryDeleteTool(fakeDevice);
    await expect(
      tool.handler({
        projectId: PROJECT_ID,
        source: 'note',
        sourceRef: 'r',
      }),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(deleteMemoryMock).not.toHaveBeenCalled();
  });
});

describe('forge_memory.search tool (regression after enum + description change)', () => {
  it('points agents at forge_step_handoff.get for handoff lookups', () => {
    const tool = forgeMemorySearchTool(fakeDevice);
    expect(tool.description).toContain('forge_step_handoff.get');
  });

  it('still routes to runMemorySearch with the parsed input', async () => {
    limit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    runMemorySearchMock.mockResolvedValueOnce({ hits: [], model: 'gemini-embedding', took_ms: 1 });

    const tool = forgeMemorySearchTool(fakeDevice);
    const r = await tool.handler({
      projectId: PROJECT_ID,
      query: 'find similar plans',
      sourceFilter: ['note'],
    });

    expect(r).toMatchObject({ hits: [], took_ms: 1 });
    expect(runMemorySearchMock).toHaveBeenCalledOnce();
  });
});
