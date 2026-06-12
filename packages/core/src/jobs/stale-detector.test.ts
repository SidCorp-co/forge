/**
 * ISS-449 (ISS-442 C3) — runStaleSweep is DEMOTED to alarm-only.
 *
 * The loop monitor's result hop (`loop-monitor.ts` `reapResultMisses`) owns
 * the no-progress reap now. These tests assert the alarm contract: the
 * detection SELECT keeps the dispatched+running coverage and the
 * result-event false-positive guard (ISS-258), runs at the loop threshold
 * PLUS the alarm margin (65 min), performs NO terminal write, and surfaces
 * every match as a `loop-miss` log + `pipeline_wedge` event.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
const updateMock = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    execute: executeMock,
    update: (...args: unknown[]) => {
      updateMock(...args);
      throw new Error('alarm pass must not write');
    },
    insert: () => {
      throw new Error('alarm pass must not write');
    },
  },
}));

vi.mock('../queue/boss.js', () => ({
  boss: { createQueue: vi.fn(), work: vi.fn(), schedule: vi.fn() },
}));

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
}));

// stale-detector only needs the loop's threshold constant; mocking the module
// keeps its finalize/agent-session import graph (→ config/env) out of the test.
vi.mock('./loop-monitor.js', () => ({
  RESULT_QUIET_MINUTES: 60,
}));

const loggerWarn = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => loggerWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
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
  emitWedgeMock.mockClear();
  loggerWarn.mockClear();
  updateMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runStaleSweep (alarm-only)', () => {
  it('SELECT covers dispatched+running at loop threshold + margin (65 min) and keeps the result-event guard', async () => {
    executeMock.mockResolvedValueOnce([]);
    await runStaleSweep();
    const text = lastSqlText(0);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/interval\s+'65 minutes'/);
    expect(text).toMatch(/COALESCE\(le\.max_ts,\s*j\.dispatched_at\)/);
    expect(text).toMatch(/NOT\s+EXISTS[\s\S]*job_events[\s\S]*kind\s*=\s*'result'/);
  });

  it('a match is ALARMED (loop-miss log + wedge), never reaped', async () => {
    executeMock.mockResolvedValueOnce([{ id: 'job-1', project_id: 'p1', issue_id: 'i1' }]);
    const result = await runStaleSweep();

    // `failed` now counts alarmed loop misses; no terminal write happened.
    expect(result.failed).toBe(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ hop: 'result', ids: ['job-1'] }),
      'loop-miss',
    );
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    expect(emitWedgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        issueId: 'i1',
        hop: 'result',
        entity: 'job',
        entityId: 'job-1',
      }),
    );
  });

  it('quiet pass: no matches → no log, no wedge', async () => {
    executeMock.mockResolvedValueOnce([]);
    const result = await runStaleSweep();
    expect(result.failed).toBe(0);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });
});
