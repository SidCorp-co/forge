/**
 * ISS-1085 slice 3 — what a `sentry_pull` tick writes.
 *
 * One `schedule_runs` row, whichever way the pull went, and NO agent session — asserted as the
 * absence of a session write, because "runs inside core" is a claim about what is not created.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const inserted: Record<string, unknown>[] = [];
const updatedSets: Record<string, unknown>[] = [];
const insertedTables: string[] = [];

function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) =>
    String(s).includes('drizzle:Name'),
  );
  return sym ? String((t as Record<symbol, unknown>)[sym]) : 'unknown';
}

vi.mock('../db/client.js', () => ({
  db: {
    insert: (t: unknown) => {
      insertedTables.push(tableName(t));
      return {
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: async () => [{ id: 'run-1' }] };
        },
      };
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updatedSets.push(patch);
        return { where: async () => undefined };
      },
    }),
  },
}));

const runSentryPullMock = vi.fn();
vi.mock('../integrations/sentry/intake.js', () => ({
  runSentryPull: (...a: unknown[]) => runSentryPullMock(...(a as [])),
}));

const resolveTargetMock = vi.fn();
vi.mock('./release-batch-dispatch.js', () => ({
  resolveScheduleTargetProject: (...a: unknown[]) => resolveTargetMock(...(a as [])),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { dispatchScheduleSentryPull } = await import('./sentry-pull-dispatch.js');

const INPUT = {
  schedule: { id: 'sched-1', projectId: 'p-1', prompt: null, targetProjectSlug: null },
  tick: true,
  // biome-ignore lint/suspicious/noExplicitAny: DispatchScheduleInput carries more than this needs
} as any;

beforeEach(() => {
  inserted.length = 0;
  updatedSets.length = 0;
  insertedTables.length = 0;
  vi.clearAllMocks();
  resolveTargetMock.mockResolvedValue({ projectId: 'p-1', userId: 'u-1' });
});

describe('dispatchScheduleSentryPull', () => {
  it('writes one schedule_runs row and creates NO agent session', async () => {
    runSentryPullMock.mockResolvedValue({ status: 'success', output: '2 issue(s) filed' });
    await dispatchScheduleSentryPull(INPUT);

    expect(insertedTables).toEqual(['schedule_runs']);
    expect(insertedTables).not.toContain('agent_sessions');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      scheduleId: 'sched-1',
      projectId: 'p-1',
      trigger: 'scheduled',
      status: 'running',
    });
  });

  it('settles that row with the pull own outcome, output and error', async () => {
    runSentryPullMock.mockResolvedValue({
      status: 'failed',
      output: 'thresholds: 10 event(s), 2 user(s)',
      error: 'sentry pull: this project has no active Sentry binding',
    });
    await dispatchScheduleSentryPull(INPUT);

    expect(updatedSets).toHaveLength(1);
    expect(updatedSets[0]).toMatchObject({
      status: 'failed',
      output: 'thresholds: 10 event(s), 2 user(s)',
      error: 'sentry pull: this project has no active Sentry binding',
    });
  });

  it('reports the dispatch failed when the pull failed, carrying the run id', async () => {
    runSentryPullMock.mockResolvedValue({ status: 'failed', output: '', error: 'boom' });
    const result = await dispatchScheduleSentryPull(INPUT);
    expect(result).toEqual({
      ok: false,
      reason: 'session-failed',
      status: 'failed',
      sessionId: 'run-1',
    });
  });

  it('reports the DISPATCH successful for a quiet night while the run row keeps the honest skipped', async () => {
    runSentryPullMock.mockResolvedValue({ status: 'skipped', output: '0 issue(s) filed' });
    const result = await dispatchScheduleSentryPull(INPUT);
    expect(result).toMatchObject({ ok: true, status: 'success' });
    expect(updatedSets[0]).toMatchObject({ status: 'skipped' });
  });

  it('skips without writing anything when the target project cannot be resolved', async () => {
    resolveTargetMock.mockResolvedValue(null);
    const result = await dispatchScheduleSentryPull(INPUT);
    expect(result).toEqual({ ok: false, reason: 'project-not-found', status: 'skipped' });
    expect(inserted).toEqual([]);
    expect(runSentryPullMock).not.toHaveBeenCalled();
  });

  it('marks a manually triggered run as manual rather than scheduled', async () => {
    runSentryPullMock.mockResolvedValue({ status: 'success', output: '' });
    await dispatchScheduleSentryPull({ ...INPUT, tick: false });
    expect(inserted[0]).toMatchObject({ trigger: 'manual' });
  });
});
