import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const dbExecute = vi.fn();
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...args),
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const isBossStartedMock = vi.fn();
const isWsListeningMock = vi.fn();
vi.mock('../../queue/boss.js', () => ({ isBossStarted: () => isBossStartedMock() }));
vi.mock('../../ws/server.js', () => ({ isWsListening: () => isWsListeningMock() }));

const getLastSeedResultMock = vi.fn();
vi.mock('../../skills/builtin-seed.js', () => ({
  getLastSeedResult: () => getLastSeedResultMock(),
}));

const { forgeHealthTool } = await import('./forge-health.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

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
  disabledAt: null,
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_health', () => {
  it('returns shape with all ok when db/queue/ws are healthy', async () => {
    const tool = forgeHealthTool(fakeDevice);
    dbExecute.mockResolvedValueOnce(undefined);
    isBossStartedMock.mockReturnValue(true);
    isWsListeningMock.mockReturnValue(true);
    getLastSeedResultMock.mockReturnValue(null);
    selectLimit.mockResolvedValueOnce([{ n: 3 }]);
    // The jobsActive query uses count() then where() then chains — our chain returns selectWhere directly.
    // Adapt: db.select(...).from().where() is the terminal Promise.
    // Re-program with proper chain for this test.
    const inactiveSelectImpl = vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve([{ n: 3 }]),
      }),
    }));
    // Override the select() spy via reassignment is not possible; instead we redirect using mockImplementationOnce on selectFrom.
    selectFrom.mockReturnValueOnce({
      where: () => Promise.resolve([{ n: 3 }]),
    } as never);

    const result = (await tool.handler({})) as {
      version: string;
      uptimeSeconds: number;
      db: string;
      queue: string;
      ws: string;
      jobsActive: number;
      lastSeed: unknown;
    };

    expect(typeof result.version).toBe('string');
    expect(result.version.length).toBeGreaterThan(0);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(result.db).toBe('ok');
    expect(result.queue).toBe('ok');
    expect(result.ws).toBe('ok');
    expect(result.jobsActive).toBe(3);
    expect(result.lastSeed).toBeNull();
  });

  it('reports db down when execute rejects (and falls back jobsActive to 0)', async () => {
    const tool = forgeHealthTool(fakeDevice);
    dbExecute.mockRejectedValueOnce(new Error('connection refused'));
    isBossStartedMock.mockReturnValue(false);
    isWsListeningMock.mockReturnValue(true);
    getLastSeedResultMock.mockReturnValue(null);

    const result = (await tool.handler({})) as {
      db: string;
      queue: string;
      ws: string;
      jobsActive: number;
    };
    expect(result.db).toBe('down');
    expect(result.queue).toBe('down');
    expect(result.ws).toBe('ok');
    expect(result.jobsActive).toBe(0);
  });

  it('returns lastSeed snapshot when seed has run', async () => {
    const tool = forgeHealthTool(fakeDevice);
    dbExecute.mockResolvedValueOnce(undefined);
    isBossStartedMock.mockReturnValue(true);
    isWsListeningMock.mockReturnValue(true);
    const at = new Date('2026-04-30T12:00:00.000Z');
    getLastSeedResultMock.mockReturnValue({ inserted: 1, updated: 2, unchanged: 3, at });
    selectFrom.mockReturnValueOnce({
      where: () => Promise.resolve([{ n: 0 }]),
    } as never);

    const result = (await tool.handler({})) as {
      lastSeed: { inserted: number; updated: number; unchanged: number; at: string } | null;
    };
    expect(result.lastSeed).toEqual({
      inserted: 1,
      updated: 2,
      unchanged: 3,
      at: '2026-04-30T12:00:00.000Z',
    });
  });
});
