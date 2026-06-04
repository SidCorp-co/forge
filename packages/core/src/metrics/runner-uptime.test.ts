import { describe, expect, it, vi } from 'vitest';

// queries.ts imports db/client at module load (env-gated); mock it — the
// function under test is pure and never touches the db.
vi.mock('../db/client.js', () => ({ db: {} }));

const { computeRunnerUptime } = await import('./queries.js');

const DAY_MS = 86_400_000;

describe('computeRunnerUptime (ISS-381 2.3)', () => {
  it('reports full uptime for a runner online across both buckets', () => {
    const buckets = ['2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'];
    const now = new Date('2026-06-03T00:00:00.000Z');
    const rows = [{ runner_id: 'r1', new_status: 'online', ts: '2026-06-01T00:00:00.000Z' }];
    const series = computeRunnerUptime(buckets, rows, DAY_MS, now);
    expect(series).toHaveLength(2);
    expect(series.map((p) => p.onlinePct)).toEqual([1, 1]);
    expect(series.every((p) => p.runnerId === 'r1')).toBe(true);
  });

  it('clips an online→offline transition to the bucket (half a day online)', () => {
    const buckets = ['2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'];
    const now = new Date('2026-06-03T00:00:00.000Z');
    const rows = [
      { runner_id: 'r1', new_status: 'online', ts: '2026-06-01T00:00:00.000Z' },
      { runner_id: 'r1', new_status: 'offline', ts: '2026-06-01T12:00:00.000Z' },
    ];
    const series = computeRunnerUptime(buckets, rows, DAY_MS, now);
    expect(series[0]?.onlinePct).toBeCloseTo(0.5);
    expect(series[1]?.onlinePct).toBe(0);
  });

  it('carries a pre-window online state into the window', () => {
    // The window is a single bucket on 06-02; the only event is an online flip on
    // 06-01 (before the window) — the runner should read as fully online.
    const buckets = ['2026-06-02T00:00:00.000Z'];
    const now = new Date('2026-06-03T00:00:00.000Z');
    const rows = [{ runner_id: 'r1', new_status: 'online', ts: '2026-06-01T00:00:00.000Z' }];
    const series = computeRunnerUptime(buckets, rows, DAY_MS, now);
    expect(series[0]?.onlinePct).toBe(1);
  });

  it('separates runners and sorts them deterministically', () => {
    const buckets = ['2026-06-01T00:00:00.000Z'];
    const now = new Date('2026-06-02T00:00:00.000Z');
    const rows = [
      { runner_id: 'rB', new_status: 'online', ts: '2026-06-01T00:00:00.000Z' },
      { runner_id: 'rA', new_status: 'offline', ts: '2026-06-01T00:00:00.000Z' },
    ];
    const series = computeRunnerUptime(buckets, rows, DAY_MS, now);
    expect(series.map((p) => p.runnerId)).toEqual(['rA', 'rB']);
    expect(series.find((p) => p.runnerId === 'rA')?.onlinePct).toBe(0);
    expect(series.find((p) => p.runnerId === 'rB')?.onlinePct).toBe(1);
  });
});
