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

  it('UPDATE filter accepts heartbeat OR recent finished_at as project activity', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await runQueuedSweep();
    const text = lastSqlText();
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('agent_sessions');
    expect(text).toContain('last_heartbeat_at');
    expect(text).toContain('finished_at');
    expect(text).toMatch(/120/);
  });

  // ISS-162 — gate state is no longer persisted. The watchdog must not
  // reference `gate_at` or `gate_reason` anywhere; project-activity NOT
  // EXISTS is now the only filter beyond the grace window.
  it('UPDATE filter contains no references to dropped gate_* columns', async () => {
    dbExecute.mockResolvedValueOnce([]);
    await runQueuedSweep();
    const text = lastSqlText();
    expect(text).not.toMatch(/gate_at/);
    expect(text).not.toMatch(/gate_reason/);
    expect(text).not.toMatch(/gate_metadata/);
  });
});
