/**
 * ISS-258 — runStaleSweep coverage.
 *
 * The sweep used to filter to `status='running'` only, so a job that landed
 * in `dispatched` and never emitted `job_events:started` (runner
 * crash/disconnect before claim) sat forever. Combined with the cap=1
 * runner gate, one such row stalled the project queue indefinitely.
 *
 * These tests assert the generated SELECT + per-row UPDATE both cover
 * `dispatched` and `running` and that the per-row UPDATE actually flips
 * a `dispatched` row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: { execute: executeMock },
}));

vi.mock('../queue/boss.js', () => ({
  boss: { createQueue: vi.fn(), work: vi.fn(), schedule: vi.fn() },
}));

vi.mock('../ws/server.js', () => ({
  roomManager: { publish: vi.fn() },
}));

vi.mock('../pipeline/manual-hold.js', () => ({
  setManualHoldBlock: vi.fn(async () => {}),
}));

vi.mock('../pipeline/hold-policy.js', () => ({
  computeHoldUntil: () => new Date('2026-05-28T00:00:00Z'),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runStaleSweep } = await import('./stale-detector.js');

function lastSqlText(callIndex: number): string {
  const arg = executeMock.mock.calls[callIndex]?.[0] as { queryChunks?: unknown };
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

beforeEach(() => {
  executeMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runStaleSweep', () => {
  it('SELECT covers both dispatched and running, with 5-minute threshold against dispatched_at', async () => {
    executeMock.mockResolvedValueOnce([]); // empty result → no per-row UPDATEs
    await runStaleSweep();
    const text = lastSqlText(0);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/interval\s+'5 minutes'/);
    expect(text).toMatch(/COALESCE\(le\.max_ts,\s*j\.dispatched_at\)/);
    expect(text).toMatch(/now\(\)\s*-\s*interval\s+'5 minutes'/);
  });

  it('per-row UPDATE flips dispatched rows (not just running)', async () => {
    executeMock.mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        project_id: '22222222-2222-4222-8222-222222222222',
        attempts: 1,
        status: 'dispatched',
        type: 'triage',
        issue_id: null,
        agent_session_id: null,
        dispatched_at: new Date(Date.now() - 10 * 60_000),
      },
    ]);
    executeMock.mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        project_id: '22222222-2222-4222-8222-222222222222',
        attempts: 1,
        status: 'failed',
        type: 'triage',
        issue_id: null,
        agent_session_id: null,
        dispatched_at: null,
      },
    ]);
    const result = await runStaleSweep();
    expect(result.failed).toBe(1);
    const updateText = lastSqlText(1);
    expect(updateText).toMatch(/UPDATE\s+jobs/);
    expect(updateText).toMatch(/status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(updateText).toMatch(/failure_kind\s*=\s*'transient'/);
    expect(updateText).toMatch(/failure_reason\s*=\s*'runner stale.*'/);
    expect(updateText).toMatch(/error\s*=\s*'stale'/);
  });

  it('does not invoke setManualHoldBlock for stale rows that have no issue_id (system jobs)', async () => {
    const { setManualHoldBlock } = await import('../pipeline/manual-hold.js');
    executeMock.mockResolvedValueOnce([
      {
        id: 'job-sys',
        project_id: 'p1',
        attempts: 1,
        status: 'dispatched',
        type: 'custom',
        issue_id: null,
        agent_session_id: null,
        dispatched_at: new Date(Date.now() - 10 * 60_000),
      },
    ]);
    executeMock.mockResolvedValueOnce([
      {
        id: 'job-sys',
        project_id: 'p1',
        attempts: 1,
        status: 'failed',
        type: 'custom',
        issue_id: null,
        agent_session_id: null,
      },
    ]);
    const r = await runStaleSweep();
    expect(r.failed).toBe(1);
    expect(r.blocked).toBe(0);
    expect(setManualHoldBlock).not.toHaveBeenCalled();
  });
});
