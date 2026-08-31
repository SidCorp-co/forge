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
  executeImpl.mockResolvedValue([]);
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
      {
        status: 'failed',
        failure_reason: 'provider_spend_cap',
        sessions: '7',
        last_at: '2026-08-27T04:15:00Z',
      },
      {
        status: 'failed',
        failure_reason: 'job_failed',
        sessions: '1397',
        last_at: '2026-08-26T00:00:00Z',
      },
      {
        status: 'failed',
        failure_reason: 'org/account spend limit → per-account failover',
        sessions: '39',
        last_at: '2026-08-25T00:00:00Z',
      },
      {
        status: 'failed',
        failure_reason: 'user_cancelled',
        sessions: '2',
        last_at: '2026-08-20T00:00:00Z',
      },
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
      { status: 'failed', failure_reason: 'provider_spend_cap', sessions: '3', last_at: null },
      { status: 'failed', failure_reason: 'job_failed', sessions: '1', last_at: null },
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
      { status: 'failed', failure_reason: 'job_failed', sessions: '5', last_at: null },
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
  it('excludes a completed session that still carries a reason, and names the count', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([
      { status: 'failed', failure_reason: 'provider_spend_cap', sessions: '4', last_at: null },
      {
        status: 'completed',
        failure_reason: 'orphan_under_terminal_run',
        sessions: '30',
        last_at: null,
      },
      { status: 'completed', failure_reason: 'heartbeat_timeout', sessions: '6', last_at: null },
      {
        status: 'completed_via_recovery',
        failure_reason: 'job_failed',
        sessions: '1',
        last_at: null,
      },
      {
        status: 'cancelled_stale',
        failure_reason: 'residency_expired',
        sessions: '2',
        last_at: null,
      },
    ]);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      total: number;
      nonFailedWithFailureReason: number;
      rows: Array<{ cause: string }>;
    };

    expect(res.total).toBe(6);
    expect(res.nonFailedWithFailureReason).toBe(37);
    expect(res.rows.map((r) => r.cause).sort()).toEqual([
      'provider_spend_cap',
      'residency_expired',
    ]);
  });

  // cm:why the row that recorded nothing at all is the purest form of the defect ISS-877 exists to end, and the first version of this query could not see it: `failure_reason IS NOT NULL` dropped it from the numerator AND the denominator, so the unclassified rate improved by not counting the worst rows.
  it('counts a failed session that recorded no reason at all as unclassified', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([
      { status: 'failed', failure_reason: null, sessions: '9', last_at: null },
      { status: 'failed', failure_reason: 'provider_spend_cap', sessions: '1', last_at: null },
    ]);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      total: number;
      unclassified: number;
      unclassifiedRate: number;
    };
    expect(res.total).toBe(10);
    expect(res.unclassified).toBe(9);
    expect(res.unclassifiedRate).toBeCloseTo(0.9);
  });

  it('does not count a completed session that recorded no reason either way', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([
      { status: 'failed', failure_reason: 'provider_spend_cap', sessions: '2', last_at: null },
    ]);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      total: number;
      nonFailedWithFailureReason: number;
    };
    expect(res.total).toBe(2);
    expect(res.nonFailedWithFailureReason).toBe(0);
  });

  it('counts a still-running session the I1 trigger stamped, which is the same lie one tense earlier', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([
      { status: 'failed', failure_reason: 'session_lost', sessions: '1', last_at: null },
      {
        status: 'running',
        failure_reason: 'orphan_under_terminal_run',
        sessions: '4',
        last_at: null,
      },
    ]);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      total: number;
      nonFailedWithFailureReason: number;
    };
    expect(res.total).toBe(1);
    expect(res.nonFailedWithFailureReason).toBe(4);
  });

  it('returns zero excluded rows rather than omitting the field when every session really failed', async () => {
    mockMembership();
    executeImpl.mockResolvedValueOnce([
      { status: 'failed', failure_reason: 'provider_auth_expired', sessions: '3', last_at: null },
    ]);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      nonFailedWithFailureReason: number;
    };
    expect(res.nonFailedWithFailureReason).toBe(0);
  });
});

describe('forge_metrics.session_failures — resumeContinuity (ISS-887)', () => {
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

  async function run(resumeRows: Array<{ drop_reason: string | null; sessions: string }>) {
    mockMembership();
    executeImpl.mockResolvedValueOnce([]);
    executeImpl.mockResolvedValueOnce(resumeRows);
    const tool = forgeMetricsSessionFailuresTool(buildCtx());
    const res = (await tool.handler({ projectId: PROJECT_ID, days: 30 })) as {
      resumeContinuity: {
        offered: number;
        resumed: number;
        dropped: number;
        dropRate: number;
        rows: Array<{ reason: string; sessions: number }>;
      };
    };
    return res.resumeContinuity;
  }

  it('counts a continued attempt and a dropped one against the same denominator', async () => {
    const out = await run([
      { drop_reason: null, sessions: '3' },
      { drop_reason: 'failure_action', sessions: '9' },
      { drop_reason: 'pin_stale', sessions: '1' },
    ]);
    expect(out.offered).toBe(13);
    expect(out.resumed).toBe(3);
    expect(out.dropped).toBe(10);
    expect(out.dropRate).toBeCloseTo(10 / 13);
    expect(out.rows).toEqual([
      { reason: 'failure_action', sessions: 9 },
      { reason: 'pin_stale', sessions: 1 },
    ]);
  });

  it('names every reason it was given rather than folding the small ones together', async () => {
    const out = await run([
      { drop_reason: 'rotation', sessions: '4' },
      { drop_reason: 'stage_pool', sessions: '1' },
      { drop_reason: 'device_tripped', sessions: '1' },
    ]);
    expect(out.rows.map((r) => r.reason)).toEqual(['rotation', 'device_tripped', 'stage_pool']);
    expect(out.dropped).toBe(6);
  });

  it('reads an empty window as nothing offered, not as a perfect score', async () => {
    const out = await run([]);
    expect(out).toEqual({ offered: 0, resumed: 0, dropped: 0, dropRate: 0, rows: [] });
  });

  // cm:edge contract -> packages/core/tests/integration/resume-continuity-e2e.test.ts — `db.execute` is mocked here, so this can only assert the query TEXT and the SQL never executes; the real predicate, JSON path and GROUP BY are exercised there. Assert the POLARITY, never just that `priorClaudeSessionId` is mentioned: `IS NULL` mentions it too, counts attempt 1 and excludes every real offer, and an earlier version of this test stayed green through exactly that inversion.
  it('asks for rows that HAVE a prior session, and does not inherit the failure filter', async () => {
    await run([{ drop_reason: 'rotation', sessions: '2' }]);
    const sqlText = JSON.stringify(executeImpl.mock.calls.at(-1));
    expect(sqlText).toContain("priorClaudeSessionId' IS NOT NULL");
    expect(sqlText).not.toContain("priorClaudeSessionId' IS NULL");
    expect(sqlText).not.toContain('cancelled_stale');
  });
});
