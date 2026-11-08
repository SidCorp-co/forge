/**
 * ISS-684 (REQ-74 BC-4): Moving, Stuck and Holds read one source for an issue a live run carries, so
 * the Delivery overview never draws a running run as Stuck, nor one silent run both Moving and Held.
 *
 * @direct-test-of packages/core/src/development/overview.ts
 */
import type { IssueAttentionGroup, IssueStandingRow } from '@forge/contracts/issue-standing';
import type { RunStanding } from '@forge/contracts/run-standing';
import { describe, expect, it } from 'vitest';
import { movingOf, movingRowsOf, stuckOf } from './overview.js';
import { runSidesOf } from './overview-holds.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');

const row = (key: string, group: IssueAttentionGroup): IssueStandingRow =>
  ({
    id: key,
    key,
    title: key,
    status: 'in_progress',
    standing: {
      attentionGroup: group,
      blockedBy: [],
      lease: null,
      step: null,
      branch: null,
      tone: 'run',
      waitingOn: null,
      touchedAt: NOW.toISOString(),
    },
  }) as unknown as IssueStandingRow;

const run = (key: string, state: RunStanding['state'], extra: Partial<RunStanding> = {}) =>
  ({
    id: `run-${key}`,
    lane: 'issue',
    state,
    issue: { key, title: key },
    issues: [key],
    job: null,
    waitingOn: { kind: 'none' },
    ...extra,
  }) as unknown as RunStanding;

describe('the overview reads a live run before the issue standing guess', () => {
  it('draws an issue a running run works as Moving, never Stuck', () => {
    const rows = [row('ISS-1', 'stuck')];
    const sides = runSidesOf([run('ISS-1', 'running')]);
    expect(movingOf(rows, new Map(), NOW, sides).lanes.map((l) => l.key)).toEqual(['ISS-1']);
    expect(stuckOf(rows, sides)).toEqual({ count: 0, chains: [] });
  });

  it('never draws an issue whose run is stuck as Moving, which Holds draws', () => {
    const rows = [row('ISS-2', 'moving')];
    const sides = runSidesOf([run('ISS-2', 'stuck')]);
    expect(sides.held.has('ISS-2')).toBe(true);
    expect(movingRowsOf(rows, sides)).toEqual([]);
    expect(movingOf(rows, new Map(), NOW, sides).count).toBe(0);
  });

  it('reads held over running where two runs carry one issue', () => {
    const sides = runSidesOf([run('ISS-3', 'running'), run('ISS-3', 'stuck')]);
    expect([...sides.running]).toEqual([]);
    expect([...sides.held]).toEqual(['ISS-3']);
  });

  it('keeps the issue standing where no live run carries the issue', () => {
    const rows = [row('ISS-4', 'moving'), row('ISS-5', 'stuck'), row('ISS-6', 'queued')];
    const sides = runSidesOf([]);
    expect(movingRowsOf(rows, sides).map((r) => r.key)).toEqual(['ISS-4']);
    expect(stuckOf(rows, sides).count).toBe(1);
  });

  it('does not draw a queued run as Moving: only a claimed or running one works it', () => {
    const rows = [row('ISS-7', 'queued')];
    const sides = runSidesOf([run('ISS-7', 'queued')]);
    expect(movingRowsOf(rows, sides)).toEqual([]);
  });
});
