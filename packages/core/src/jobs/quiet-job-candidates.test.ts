/**
 * ISS-1013 — the result hop and the stale alarm run ONE candidate predicate.
 *
 * The alarm's whole meaning is "the loop did not act on a row it should have",
 * which it can only mean while it selects the rows the loop selects. Before
 * this, the two were separate texts that had drifted four ways; the fix was to
 * make them one object, and this file is what holds them there. It asserts on
 * the two texts rather than on a call to the builder, because a call proves
 * only that the function was reached — a caller can still pass terms that
 * change which rows come back, and that is exactly the drift being prevented.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

const { dbExecute } = vi.hoisted(() => ({
  dbExecute: vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>),
}));
vi.mock('../db/client.js', () => ({
  db: {
    execute: dbExecute,
    transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb({}),
  },
}));
vi.mock('./finalize-failure.js', () => ({ finalizeFailedJob: vi.fn(async () => undefined) }));
vi.mock('../pipeline/answer-resume.js', () => ({ resumeLapsedAnswers: vi.fn(async () => 0) }));
vi.mock('../pipeline/wedge.js', () => ({ emitPipelineWedge: vi.fn(async () => undefined) }));
vi.mock('./agent-session-link.js', () => ({ broadcastSessionEvent: vi.fn() }));
vi.mock('../queue/boss.js', () => ({
  boss: { createQueue: vi.fn(), work: vi.fn(), schedule: vi.fn() },
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./kill-gate.js', () => ({
  killGraceMs: () => 90_000,
  requestJobKill: vi.fn(),
  resolveKillConfirmation: vi.fn(),
  killEpisodeWindowMs: () => 180_000,
  isKillEpisodeLive: () => false,
}));

const { resultMissCandidateQuery, reapResultMisses, RESULT_QUIET_MINUTES } = await import(
  './loop-monitor.js'
);
const { staleAlarmQuery } = await import('./stale-detector.js');
const { quietJobCandidateQuery } = await import('./progress-signal.js');

/** Flatten a drizzle `sql` template into its raw text, bound values included. */
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

/**
 * The predicate half of a query, with the three differences the two callers
 * are ALLOWED to carry removed: the threshold, and the alarm's kill-gate term.
 * The column list is dropped by starting at `FROM`. Anything else that differs
 * is drift, and is what this normalisation exists to expose.
 */
function predicateOnly(text: string): string {
  return text
    .slice(text.indexOf('FROM jobs j'))
    .replace(/interval\s+'\s*\d+\s*minutes'/, "interval '<N> minutes'")
    .replace(/AND\s*\(\s*j\.kill_requested_at\s+IS\s+NULL[\s\S]*?\)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the result hop and the stale alarm share one candidate predicate', () => {
  it('selects the same rows, differing only in threshold and kill-gate term', () => {
    const loop = predicateOnly(sqlText(resultMissCandidateQuery()));
    const alarm = predicateOnly(sqlText(staleAlarmQuery(new Date('2026-06-12T12:00:00Z'))));

    expect(alarm).toBe(loop);
    expect(loop).toContain('LEFT JOIN LATERAL');
    expect(loop).toContain("j.status IN ('dispatched', 'running')");
    expect(loop).toContain("runtime_state IS DISTINCT FROM 'awaiting_input'");
  });

  it('keeps the thresholds that differ: 60 for the hop, 65 for the alarm', () => {
    expect(sqlText(resultMissCandidateQuery())).toMatch(/interval\s+'\s*60\s*minutes'/);
    expect(sqlText(staleAlarmQuery(new Date()))).toMatch(/interval\s+'\s*65\s*minutes'/);
  });

  it('gives the alarm the kill-gate term and the hop none', () => {
    expect(sqlText(staleAlarmQuery(new Date()))).toContain('j.kill_requested_at IS NULL');
    expect(sqlText(resultMissCandidateQuery())).not.toContain('j.kill_requested_at IS NULL');
  });

  it('is the text the result hop actually executes', async () => {
    expect(RESULT_QUIET_MINUTES).toBe(60);
    dbExecute.mockResolvedValueOnce([]);
    await reapResultMisses(new Date('2026-06-12T00:00:00Z'));
    const text = sqlText(dbExecute.mock.calls[0]?.[0]);
    expect(text).toMatch(/j\.status\s+IN\s*\(\s*'dispatched'\s*,\s*'running'\s*\)/);
    expect(text).toMatch(/interval\s+'\s*60\s*minutes'/);
    expect(text).toMatch(/COALESCE\(le\.max_ts,\s*j\.dispatched_at\)/);
    expect(text).toMatch(
      /LEFT\s+JOIN\s+LATERAL[\s\S]*job_events\s+e\s+WHERE\s+e\.job_id\s*=\s*j\.id\s+AND\s+e\.kind\s*=\s*'result'[\s\S]*\)\s*lr\s+ON\s+true/,
    );
    expect(text).toMatch(/s\.runtime_state\s+IS\s+NOT\s+NULL\s+OR\s+lr\.job_id\s+IS\s+NULL/);
    expect(text).toMatch(/kill_requested_at/);
  });

  it('scopes to a project only when asked', () => {
    expect(sqlText(resultMissCandidateQuery({ projectId: 'p-1' }))).toContain('j.project_id =');
    expect(sqlText(resultMissCandidateQuery())).not.toContain('j.project_id =');
  });
});

describe('quietJobCandidateQuery refuses a threshold it cannot interpolate safely', () => {
  it.each([
    ['a fractional threshold', 1.5],
    ['zero', 0],
    ['a negative threshold', -60],
    ['NaN', Number.NaN],
  ])('refuses %s by name', (_label, quietMinutes) => {
    expect(() => quietJobCandidateQuery({ columns: sql`j.id`, quietMinutes })).toThrow(
      /quietMinutes must be a positive integer/,
    );
  });

  it('accepts the two thresholds this repository actually passes', () => {
    expect(() => quietJobCandidateQuery({ columns: sql`j.id`, quietMinutes: 60 })).not.toThrow();
    expect(() => quietJobCandidateQuery({ columns: sql`j.id`, quietMinutes: 65 })).not.toThrow();
  });
});
