import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the drizzle client so we can control the SUM query result and assert
// it is NOT issued when the gate short-circuits at stageStatus / budget.
vi.mock('../db/client.js', () => {
  const execute = vi.fn(async () => [{ spent: 0 }]);
  // `select(...).from(...).innerJoin(...).where(...).limit(...)` chain used
  // by `postBudgetExhaustedComment`. None of the unit tests below call into
  // it, but a mock prevents the lazy chain from crashing during import.
  const select = vi.fn(() => ({
    from: () => ({
      innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  }));
  return { db: { execute, select, insert: vi.fn() } };
});

// `resolveStageOverrides` walks `projects.agentConfig.pipelineConfig.states`
// in real code; here we stub it so the unit test stays focused on the
// decision tree.
vi.mock('./stage-overrides.js', () => ({
  extractStageStatus: vi.fn(),
  resolveStageOverrides: vi.fn(),
}));

const { db } = await import('../db/client.js');
const { extractStageStatus, resolveStageOverrides } = await import('./stage-overrides.js');
const { checkMonthlyBudget, shouldEmitWarn, __resetBudgetWarnDedup } = await import(
  './budget-check.js'
);

type JobRow = {
  id: string;
  projectId: string;
  issueId: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
};

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'j1',
    projectId: 'p1',
    issueId: 'i1',
    type: 'code',
    payload: { stageStatus: 'approved' },
    status: 'queued',
    ...overrides,
  };
}

function stubOverrides(budget: { perMonthUsd?: number; action?: 'warn' | 'pause' } | null): void {
  (resolveStageOverrides as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    systemPrompt: null,
    model: null,
    allowedTools: null,
    permissionMode: null,
    timeoutSeconds: null,
    mcpServers: null,
    budget: budget,
    sessionGroup: null,
  });
}

function stubSpent(spent: number): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock
  (db as any).execute.mockResolvedValueOnce([{ spent }]);
}

describe('budget-check.checkMonthlyBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBudgetWarnDedup();
  });

  it('returns allow when payload has no stageStatus and does NOT query the DB', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const result = await checkMonthlyBudget(makeJob({ payload: {} }) as never);
    expect(result).toEqual({ action: 'allow', spent: 0, budget: null, stageStatus: null });
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((db as any).execute).not.toHaveBeenCalled();
    expect(resolveStageOverrides).not.toHaveBeenCalled();
  });

  it('returns allow when stage has no perMonthUsd budget and does NOT query the DB', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides(null);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result).toEqual({ action: 'allow', spent: 0, budget: null, stageStatus: 'approved' });
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    expect((db as any).execute).not.toHaveBeenCalled();
  });

  it('returns allow when spent is under 80%', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100, action: 'pause' });
    stubSpent(50);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result).toEqual({ action: 'allow', spent: 50, budget: 100, stageStatus: 'approved' });
  });

  it('returns warn-80 at exactly 80% spent with action=pause', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100, action: 'pause' });
    stubSpent(80);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result.action).toBe('warn-80');
    expect(result.spent).toBe(80);
    expect(result.budget).toBe(100);
  });

  it('returns warn-80 at 80% spent with action=warn', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100, action: 'warn' });
    stubSpent(80);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result.action).toBe('warn-80');
  });

  it('returns pause at 100% spent with action=pause', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100, action: 'pause' });
    stubSpent(100);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result.action).toBe('pause');
  });

  it('returns warn-80 at 100% spent with action=warn (warn-only, no enforcement)', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100, action: 'warn' });
    stubSpent(100);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result.action).toBe('warn-80');
  });

  it('returns pause when spent exceeds budget under action=pause', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100, action: 'pause' });
    stubSpent(150);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result.action).toBe('pause');
    expect(result.spent).toBe(150);
  });

  it('defaults to action=pause when perMonthUsd is set without explicit action', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100 });
    stubSpent(100);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result.action).toBe('pause');
  });

  it('returns allow (fail-open) when the SUM query throws and logs a warning', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100, action: 'pause' });
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    (db as any).execute.mockRejectedValueOnce(new Error('connection refused'));
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result.action).toBe('allow');
    expect(result.budget).toBe(100);
    expect(result.spent).toBe(0);
  });

  it('coerces a numeric-string SUM result (drizzle/pg quirks)', async () => {
    (extractStageStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce('approved');
    stubOverrides({ perMonthUsd: 100, action: 'pause' });
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock
    (db as any).execute.mockResolvedValueOnce([{ spent: '85.5' }]);
    const result = await checkMonthlyBudget(makeJob() as never);
    expect(result.spent).toBeCloseTo(85.5);
    expect(result.action).toBe('warn-80');
  });
});

describe('budget-check.shouldEmitWarn', () => {
  afterEach(() => {
    __resetBudgetWarnDedup();
  });

  it('returns true on first call and false on the second call within the same hour bucket', () => {
    expect(shouldEmitWarn('p1', 'approved')).toBe(true);
    expect(shouldEmitWarn('p1', 'approved')).toBe(false);
  });

  it('returns true for a different (project, stage) tuple in the same hour bucket', () => {
    expect(shouldEmitWarn('p1', 'approved')).toBe(true);
    expect(shouldEmitWarn('p2', 'approved')).toBe(true);
    expect(shouldEmitWarn('p1', 'developed')).toBe(true);
  });

  it('rolls the bucket forward and re-emits when the system clock moves into the next hour', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-24T00:00:00Z'));
      expect(shouldEmitWarn('p1', 'approved')).toBe(true);
      expect(shouldEmitWarn('p1', 'approved')).toBe(false);
      vi.setSystemTime(new Date('2026-05-24T01:00:00Z'));
      expect(shouldEmitWarn('p1', 'approved')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
