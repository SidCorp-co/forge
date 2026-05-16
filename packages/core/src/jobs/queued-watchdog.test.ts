import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: { execute: dbExecute },
}));

const setManualHoldBlock = vi.fn(async () => undefined);
vi.mock('../pipeline/manual-hold.js', () => ({
  setManualHoldBlock: (...args: unknown[]) => setManualHoldBlock(...(args as [never])),
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
      blocked: 0,
      durationMs: expect.any(Number),
    });
    expect(setManualHoldBlock).not.toHaveBeenCalled();
  });

  it('marks stale-queued jobs failed with transient classification', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', issueId: null, type: 'code', attempts: 1 },
    ]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(1);
    const text = lastSqlText();
    expect(text).toContain('failure_kind');
    expect(text).toContain('transient');
  });

  it('blocks each stale job with an issue via setManualHoldBlock', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', issueId: 'i1', type: 'code', attempts: 1, agentSessionId: null },
      { id: 'j2', issueId: 'i2', type: 'plan', attempts: 1, agentSessionId: null },
    ]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(2);
    expect(r.blocked).toBe(2);
    expect(setManualHoldBlock).toHaveBeenCalledTimes(2);
    const firstCall = setManualHoldBlock.mock.calls[0]?.[0] as {
      issueId: string;
      context: { trigger: string; step: string };
    } | undefined;
    expect(firstCall?.issueId).toBe('i1');
    expect(firstCall?.context.trigger).toBe('watchdog_kill');
    expect(firstCall?.context.step).toBe('code');
  });

  it('skips block when job has no issueId (PM / non-issue job)', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'pm1', issueId: null, type: 'pm', attempts: 1, agentSessionId: null },
    ]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(1);
    expect(r.blocked).toBe(0);
    expect(setManualHoldBlock).not.toHaveBeenCalled();
  });

  it('continues sweeping when setManualHoldBlock throws on one row', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', issueId: 'i1', type: 'code', attempts: 1, agentSessionId: null },
      { id: 'j2', issueId: 'i2', type: 'plan', attempts: 1, agentSessionId: null },
    ]);
    setManualHoldBlock
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(2);
    expect(r.blocked).toBe(1);
  });

  it('UPDATE filter excludes jobs with fresh gate_at + project activity', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await runQueuedSweep();
    const text = lastSqlText();
    expect(text).toContain('gate_at');
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('agent_sessions');
    expect(text).toContain('last_heartbeat_at');
  });

  // ISS-134 — regression guard. Release jobs gated by a non-terminal
  // decomposition parent rely on `pickNextDispatchableJobForProject`
  // refreshing `gate_at` every tick. The watchdog's job is to leave those
  // alone; this test pins the 300s freshness window into the UPDATE filter
  // so a future refactor can't widen it to "ignore gate_at entirely" and
  // resurrect the 05:24-05:51Z 2026-05-16 regression that killed ISS-122 /
  // 126 / 127 / 128.
  it('preserves the 300s gate_at freshness window in the UPDATE filter', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const r = await runQueuedSweep();
    expect(r.markedFailed).toBe(0);
    const text = lastSqlText();
    expect(text).toMatch(/gate_at\s+IS\s+NULL/);
    expect(text).toMatch(/gate_at\s*<\s*now\(\)\s*-\s*interval/);
    expect(text).toContain('300');
  });
});
