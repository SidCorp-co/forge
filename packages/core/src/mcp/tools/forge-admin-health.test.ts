import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectImpl = vi.fn();
const selectDistinctImpl = vi.fn();
const executeImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
    selectDistinct: (...a: unknown[]) => selectDistinctImpl(...a),
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

// loadVisibleProjectIdsForPrincipal: selectDistinct({id}).from.leftJoin.where.
function mockVisible(ids: string[]) {
  selectDistinctImpl.mockImplementationOnce(() => ({
    from: () => ({
      leftJoin: () => ({
        where: () => Promise.resolve(ids.map((id) => ({ id }))),
      }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectImpl.mockReset();
  selectDistinctImpl.mockReset();
  executeImpl.mockReset();
});

function collectSqlFragments(sqlArg: unknown): string {
  const fragments: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      fragments.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node && typeof node === 'object') {
      const value = (node as { value?: unknown }).value;
      if (typeof value === 'string') fragments.push(value);
      else if (Array.isArray(value)) visit(value);
      const chunks = (node as { queryChunks?: unknown }).queryChunks;
      if (chunks) visit(chunks);
    }
  };
  visit(sqlArg);
  return fragments.join(' ');
}

describe('forge_admin_health', () => {
  it('returns health snapshot scoped to visible projects', async () => {
    mockVisible([PROJECT_ID]);
    // db.execute(`select 1`) → succeeds
    executeImpl.mockResolvedValueOnce([{ '?column?': 1 }]);
    // runner rows (scoped: from().where())
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: () =>
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
      }),
    }));
    // in-flight aggregation: capture the where() predicate so we can assert the
    // job-status filter is applied (without it, terminal jobs would count).
    const inFlightWhere = vi.fn(() => ({
      groupBy: () => Promise.resolve([{ runnerId: RUNNER_ID, n: 3 }]),
    }));
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        where: inFlightWhere,
      }),
    }));
    // projects aggregation (scoped: leftJoin().where().groupBy().orderBy().limit())
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve([{ id: PROJECT_ID, slug: 'p1', n: 5 }]),
              }),
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

    // The in-flight aggregation must filter jobs by status so that done /
    // failed / cancelled jobs are excluded from inFlightCount.
    expect(inFlightWhere).toHaveBeenCalledTimes(1);
    const wherePredicate = inFlightWhere.mock.calls[0][0];
    const sqlText = collectSqlFragments(wherePredicate);
    expect(sqlText).toContain('dispatched');
    expect(sqlText).toContain('running');
  });

  it('honors custom staleJobThresholdSeconds', async () => {
    mockVisible([PROJECT_ID]);
    executeImpl.mockResolvedValueOnce([{ '?column?': 1 }]);
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve([]),
              }),
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

  it('returns global status but no tenant data when caller has no visible projects', async () => {
    mockVisible([]);
    executeImpl.mockResolvedValueOnce([{ '?column?': 1 }]); // select 1
    const tool = forgeAdminHealthTool(buildCtx());
    const res = (await tool.handler({ action: 'get' })) as {
      db: string;
      runners: unknown[];
      projects: unknown[];
      stuckJobs: unknown[];
    };
    expect(res.db).toBe('ok');
    expect(res.runners).toEqual([]);
    expect(res.projects).toEqual([]);
    expect(res.stuckJobs).toEqual([]);
  });
});
