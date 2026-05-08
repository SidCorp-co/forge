import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: { execute: dbExecute },
}));

const scheduleRetry = vi.fn(async () => ({ scheduled: true, newJobId: 'retry-id' }));
vi.mock('./retry.js', () => ({
  scheduleRetry: (...args: unknown[]) => scheduleRetry(...(args as [never, never])),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../queue/boss.js', () => ({
  boss: {
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async () => 'wid'),
    schedule: vi.fn(async () => undefined),
  },
}));

const { runQueuedSweep } = await import('./queued-watchdog.js');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

function lastSqlText(): string {
  const calls = dbExecute.mock.calls;
  const call = calls.length > 0 ? (calls[calls.length - 1] as unknown as unknown[])[0] : undefined;
  if (!call) return '';
  const c = call as { queryChunks?: unknown[]; sql?: string };
  if (typeof c.sql === 'string') return c.sql;
  return JSON.stringify(c.queryChunks ?? c);
}

describe('runQueuedSweep', () => {
  it('returns zeros when no jobs are stale-queued', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const r = await runQueuedSweep();
    expect(r).toEqual({
      markedFailed: 0,
      retriesScheduled: 0,
      durationMs: expect.any(Number),
    });
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it('marks stale-queued jobs failed with transient classification', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', status: 'failed', error: 'queued > 600s', attempts: 1, maxAttempts: 3 },
    ]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(1);
    const text = lastSqlText();
    expect(text).toContain('queued');
    expect(text).toContain('failure_kind');
    expect(text).toContain('transient');
  });

  it('schedules a retry per stale job and counts the successes', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', attempts: 1, maxAttempts: 3 },
      { id: 'j2', attempts: 1, maxAttempts: 3 },
    ]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(2);
    expect(r.retriesScheduled).toBe(2);
    expect(scheduleRetry).toHaveBeenCalledTimes(2);
  });

  it('does not crash when scheduleRetry throws — leaves the row failed', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', attempts: 1, maxAttempts: 3 },
      { id: 'j2', attempts: 1, maxAttempts: 3 },
    ]);
    scheduleRetry.mockRejectedValueOnce(new Error('boss down')).mockResolvedValueOnce({
      scheduled: true,
      newJobId: 'r2',
    });
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(2);
    expect(r.retriesScheduled).toBe(1);
  });

  it('UPDATE filter excludes manual_hold-gated jobs (ISS-66)', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await runQueuedSweep();
    const text = lastSqlText();
    expect(text).toContain('manual_hold');
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('agent_sessions');
  });

  it('does not sweep manual_hold-gated jobs (ISS-66 regression)', async () => {
    // The SQL filter excludes them, so db.execute returns nothing.
    dbExecute.mockResolvedValueOnce([]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(0);
    expect(r.retriesScheduled).toBe(0);
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  it('still sweeps non-manual-hold gated jobs (project_full, runner_full)', async () => {
    // Jobs gated by project_full / runner_full / waiting_on_dep self-clear,
    // so the existing watchdog behavior must continue for them.
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', attempts: 1, maxAttempts: 3, agentSessionId: 's1' },
    ]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(1);
    expect(r.retriesScheduled).toBe(1);
    expect(scheduleRetry).toHaveBeenCalledTimes(1);
  });
});
