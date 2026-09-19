import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
const updateReturning = vi.fn();
const sweepWhereArgs: unknown[] = [];
const sweepSetArgs: Array<Record<string, unknown>> = [];
const selectLimit = vi.fn(async () => [] as Array<{ issueId: string | null }>);

vi.mock('../db/client.js', () => {
  const dbStub: Record<string, unknown> = {
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(dbStub),
    execute: (...args: unknown[]) => dbExecute(...(args as [])),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        sweepSetArgs.push(patch);
        return {
          where: (arg: unknown) => {
            sweepWhereArgs.push(arg);
            return { returning: () => updateReturning() };
          },
        };
      },
    }),
    insert: () => ({ values: async () => undefined }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => selectLimit() }) }) }),
  };
  return { db: dbStub };
});

const finalizeFailedJobMock = vi.fn(async (..._args: unknown[]) => ({ scheduled: false }));
vi.mock('./finalize-failure.js', () => ({
  finalizeFailedJob: (...args: unknown[]) => finalizeFailedJobMock(...args),
}));

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/answer-resume.js', () => ({ resumeLapsedAnswers: vi.fn(async () => 0) }));

vi.mock('../pipeline/wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
}));

const broadcastSessionEventMock = vi.fn();
vi.mock('./agent-session-link.js', () => ({
  broadcastSessionEvent: (...args: unknown[]) => broadcastSessionEventMock(...args),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const requestJobKillMock = vi.fn(async (..._args: unknown[]) => 'requested' as const);
let resolveKillConfirmationResult: { confirmed: boolean; outcome: string | null } = {
  confirmed: false,
  outcome: null,
};
const resolveKillConfirmationMock = vi.fn(
  async (..._args: unknown[]) => resolveKillConfirmationResult,
);
let killGraceMsValue = 90_000;
vi.mock('./kill-gate.js', () => ({
  requestJobKill: (...args: unknown[]) => requestJobKillMock(...args),
  resolveKillConfirmation: (...args: unknown[]) => resolveKillConfirmationMock(...args),
  killGraceMs: () => killGraceMsValue,
  killEpisodeWindowMs: () => killGraceMsValue * 2,
  isKillEpisodeLive: (job: { killRequestedAt: Date | null }) =>
    job.killRequestedAt !== null &&
    Date.now() - job.killRequestedAt.getTime() <= killGraceMsValue * 2,
}));

const { reapAckMisses, reapSessionLostJobs, reapResultMisses } = await import('./loop-monitor.js');

/** Flatten a drizzle `sql` template into its raw text for fragment assertions. */
function sqlText(arg: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (n && typeof n === 'object') {
      const v = (n as { value?: unknown }).value;
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) walk(v);
      const c = (n as { queryChunks?: unknown }).queryChunks;
      if (c) walk(c);
    }
  };
  walk(arg);
  return out.join(' ');
}

/** A raw-execute candidate row for a job-axis hop — id + the kill-gate
 *  columns every hop now selects. */
function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    project_id: 'p1',
    issue_id: 'i1',
    device_id: 'device-1',
    runner_id: 'runner-1',
    kill_requested_at: null,
    kill_confirmed_at: null,
    kill_outcome: null,
    ...overrides,
  };
}

describe('ISS-1021 — the job-axis bound, and the page it reports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbExecute.mockResolvedValue([]);
    updateReturning.mockReset().mockResolvedValue([]);
    selectLimit.mockReset().mockResolvedValue([]);
    requestJobKillMock.mockClear().mockResolvedValue('requested');
    resolveKillConfirmationResult = { confirmed: false, outcome: null };
    resolveKillConfirmationMock.mockClear();
    killGraceMsValue = 90_000;
  });

  const hops: Array<[string, (now: Date) => Promise<unknown>, RegExp]> = [
    [
      'reapAckMisses',
      (now) => reapAckMisses(now),
      /ORDER\s+BY\s+j\.dispatched_at\s+ASC\s+LIMIT\s+200\s*$/,
    ],
    [
      'reapSessionLostJobs',
      (now) => reapSessionLostJobs(now),
      /ORDER\s+BY\s+j\.dispatched_at\s+ASC\s+NULLS\s+FIRST\s+LIMIT\s+200\s*$/,
    ],
    [
      'reapResultMisses',
      (now) => reapResultMisses(now),
      /ORDER\s+BY\s+j\.dispatched_at\s+ASC\s+NULLS\s+FIRST\s+LIMIT\s+200\s*$/,
    ],
  ];

  it.each(hops)(
    '%s bounds its page oldest-dispatch-first, after the predicate',
    async (_name, run, tail) => {
      dbExecute.mockResolvedValueOnce([]);
      await run(new Date('2026-06-12T00:00:00Z'));
      // Whitespace collapsed so the assertion reads the statement rather than its formatting.
      const text = sqlText(dbExecute.mock.calls[0]?.[0]).replace(/\s+/g, ' ').trim();
      expect(text).toMatch(tail);
    },
  );

  it('a hop that fills its page warns with the hop and the count it examined', async () => {
    const { logger } = await import('../logger.js');
    dbExecute.mockResolvedValueOnce(
      Array.from({ length: 200 }, (_, i) => candidateRow({ id: `job-${i}` })),
    );

    await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    const warn = vi
      .mocked(logger.warn)
      .mock.calls.find((c) => (c[0] as { hop?: string } | undefined)?.hop === 'ack');
    expect(warn?.[0]).toEqual({ hop: 'ack', limit: 200, examined: 200 });
  });

  // The boundary, because `reportHopPage` compares with `>=` and the warn exists to say there may
  // be more: a page of 199 is the whole candidate set, not a truncation.
  it('a hop one row short of its page says nothing', async () => {
    const { logger } = await import('../logger.js');
    dbExecute.mockResolvedValueOnce(
      Array.from({ length: 199 }, (_, i) => candidateRow({ id: `job-${i}` })),
    );

    await reapAckMisses(new Date('2026-06-12T00:00:00Z'));

    const warn = vi
      .mocked(logger.warn)
      .mock.calls.find((c) => (c[0] as { hop?: string } | undefined)?.hop === 'ack');
    expect(warn).toBeUndefined();
  });
});
