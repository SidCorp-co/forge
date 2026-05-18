import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectImpl = vi.fn();
const executeImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
    execute: (...a: unknown[]) => executeImpl(...a),
  },
}));

vi.mock('../../queue/boss.js', () => ({
  isBossStarted: () => true,
}));

vi.mock('../../ws/server.js', () => ({
  isWsListening: () => true,
}));

const { forgeAdminHealthTool } = await import('./forge-admin-health.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

function buildCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

function mockCeoLookup(isCeo: boolean) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([{ isCeo }]),
      }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectImpl.mockReset();
  executeImpl.mockReset();
});

describe('forge_admin_health', () => {
  it('returns extended health snapshot', async () => {
    mockCeoLookup(true);
    // db.execute(`select 1`) → succeeds
    executeImpl.mockResolvedValueOnce([{ '?column?': 1 }]);
    // runner rows
    selectImpl.mockImplementationOnce(() => ({
      from: () =>
        Promise.resolve([
          {
            id: RUNNER_ID,
            projectId: PROJECT_ID,
            type: 'claude-code',
            host: 'device',
            deviceId: DEVICE_ID,
            name: 'r1',
            labels: [],
            capabilities: {},
            config: {},
            status: 'online',
            lastSeenAt: null,
            lastError: null,
          },
        ]),
    }));
    // in-flight aggregation
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          groupBy: () => Promise.resolve([{ runnerId: RUNNER_ID, n: 3 }]),
        }),
      }),
    }));
    // projects aggregation
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          groupBy: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([{ id: PROJECT_ID, slug: 'p1', n: 5 }]),
            }),
          }),
        }),
      }),
    }));
    // stuck jobs
    executeImpl.mockResolvedValueOnce([
      {
        id: 'job-1',
        type: 'plan',
        runner_id: RUNNER_ID,
        dispatched_at: '2026-05-18T00:00:00Z',
        age_seconds: 1200,
      },
    ]);

    const tool = forgeAdminHealthTool(buildCtx());
    const res = (await tool.handler({ action: 'get' })) as {
      runners: Array<{ inFlightCount: number }>;
      projects: Array<{ activeJobCount: number }>;
      stuckJobs: Array<{ ageSeconds: number }>;
      db: string;
      queue: string;
      ws: string;
    };
    expect(res.db).toBe('ok');
    expect(res.queue).toBe('ok');
    expect(res.ws).toBe('ok');
    expect(res.runners[0].inFlightCount).toBe(3);
    expect(res.projects[0].activeJobCount).toBe(5);
    expect(res.stuckJobs[0].ageSeconds).toBe(1200);
  });

  it('honors custom staleJobThresholdSeconds', async () => {
    mockCeoLookup(true);
    executeImpl.mockResolvedValueOnce([{ '?column?': 1 }]);
    selectImpl.mockImplementationOnce(() => ({
      from: () => Promise.resolve([]),
    }));
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          groupBy: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }));
    executeImpl.mockResolvedValueOnce([]);
    const tool = forgeAdminHealthTool(buildCtx());
    const res = (await tool.handler({
      action: 'get',
      staleJobThresholdSeconds: 60,
    })) as { staleJobThresholdSeconds: number };
    expect(res.staleJobThresholdSeconds).toBe(60);
  });

  it('FORBIDDEN when not CEO', async () => {
    mockCeoLookup(false);
    const tool = forgeAdminHealthTool(buildCtx());
    await expect(tool.handler({ action: 'get' })).rejects.toThrow(/FORBIDDEN/);
  });
});
