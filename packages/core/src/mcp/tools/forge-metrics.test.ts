import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectDistinctImpl = vi.fn();
const selectImpl = vi.fn();
const executeImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
    selectDistinct: (...a: unknown[]) => selectDistinctImpl(...a),
    execute: (...a: unknown[]) => executeImpl(...a),
  },
}));

const {
  forgeMetricsProjectRetryRescuesTool,
  forgeMetricsSessionFailuresTool,
  forgeMetricsStepDurationsTool,
} = await import('./forge-metrics.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

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

function buildCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

function mockVisible(ids: string[]) {
  selectDistinctImpl.mockImplementationOnce(() => ({
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(ids.map((id) => ({ id }))),
        }),
      }),
    }),
  }));
}

// Flatten a drizzle `sql` template into its literal text chunks.
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

beforeEach(() => {
  vi.clearAllMocks();
  selectDistinctImpl.mockReset();
  selectImpl.mockReset();
  executeImpl.mockReset();
});

describe('forge_metrics.step_durations', () => {
  it('returns empty without querying when caller has no visible projects', async () => {
    mockVisible([]);
    const tool = forgeMetricsStepDurationsTool(buildCtx());
    const res = (await tool.handler({ days: 30 })) as { rows: unknown[]; windowDays: number };
    expect(res.rows).toEqual([]);
    expect(res.windowDays).toBe(30);
    expect(executeImpl).not.toHaveBeenCalled();
  });

  it('scopes to visible projects with IN (...) — not ANY(::uuid[]) (array-binding regression)', async () => {
    mockVisible([PROJECT_ID]);
    executeImpl.mockResolvedValueOnce([]);
    const tool = forgeMetricsStepDurationsTool(buildCtx());
    await tool.handler({ days: 30 });

    expect(executeImpl).toHaveBeenCalledTimes(1);
    const sqlText = collectSqlFragments(executeImpl.mock.calls[0]?.[0]);
    expect(sqlText).toContain('IN (');
    expect(sqlText).not.toContain('ANY(');
    expect(sqlText).not.toContain('::uuid[]');
  });
});

describe('forge_metrics.project_retry_rescues', () => {
  it('returns per-reason rescues for a project member', async () => {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]),
            }),
          }),
        }),
      }),
    }));
    executeImpl.mockResolvedValueOnce([
      {
        failure_kind: 'infra',
        failure_reason: 'hooks_path',
        rescues: '46',
        last_rescued_at: '2026-08-12T09:00:00Z',
      },
    ]);

    const tool = forgeMetricsProjectRetryRescuesTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      total: number;
      rows: Array<{ failureReason: string; rescues: number }>;
    };

    expect(res.total).toBe(46);
    expect(res.rows).toEqual([
      {
        failureKind: 'infra',
        failureReason: 'hooks_path',
        rescues: 46,
        lastRescuedAt: '2026-08-12T09:00:00Z',
      },
    ]);
  });
});

describe('forge_metrics.session_failures (ISS-877)', () => {
  function mockMembership() {
    selectImpl.mockImplementationOnce(() => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]),
            }),
          }),
        }),
      }),
    }));
  }

  it('groups by cause and folds every legacy spelling of "we did not classify it" into one counted row', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([
      { failure_reason: 'provider_spend_cap', sessions: '7', last_at: '2026-08-27T04:15:00Z' },
      { failure_reason: 'job_failed', sessions: '1397', last_at: '2026-08-26T00:00:00Z' },
      {
        failure_reason: 'org/account spend limit → per-account failover',
        sessions: '39',
        last_at: '2026-08-25T00:00:00Z',
      },
      { failure_reason: 'user_cancelled', sessions: '2', last_at: '2026-08-20T00:00:00Z' },
    ]);

    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      total: number;
      unclassified: number;
      unclassifiedRate: number;
      rows: Array<{ cause: string; origin: string; sessions: number; isRealFailure: boolean }>;
    };

    expect(res.total).toBe(1445);
    expect(res.unclassified).toBe(1436);
    expect(res.rows[0]).toMatchObject({
      cause: 'unclassified',
      origin: 'unknown',
      sessions: 1436,
    });
    expect(res.rows.find((r) => r.cause === 'provider_spend_cap')).toMatchObject({
      origin: 'provider',
      sessions: 7,
      isRealFailure: true,
    });
    expect(res.rows.find((r) => r.cause === 'user_cancelled')?.isRealFailure).toBe(false);
  });

  it('reports the unclassified rate rather than only the classified share', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([
      { failure_reason: 'provider_spend_cap', sessions: '3', last_at: null },
      { failure_reason: 'job_failed', sessions: '1', last_at: null },
    ]);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      unclassifiedRate: number;
    };
    expect(res.unclassifiedRate).toBeCloseTo(0.25);
  });

  it('never omits the unclassified row, which is the only reason the rate stays honest', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([
      { failure_reason: 'job_failed', sessions: '5', last_at: null },
    ]);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      rows: Array<{ cause: string }>;
      unclassifiedRate: number;
    };
    expect(res.rows.map((r) => r.cause)).toContain('unclassified');
    expect(res.unclassifiedRate).toBe(1);
  });

  it('returns a zero rate rather than NaN when the window is empty', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([]);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      rows: unknown[];
      total: number;
      unclassifiedRate: number;
    };
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.unclassifiedRate).toBe(0);
  });
});
