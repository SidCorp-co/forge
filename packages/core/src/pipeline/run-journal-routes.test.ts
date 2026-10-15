/**
 * ISS-1133 — the issue page's one read of what a run did: each run of the issue, newest first,
 * holding the attempts the run journal recorded for it in the order they started.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const { groupByRun } = await import('./run-journal-routes.js');

type Row = Parameters<typeof groupByRun>[1][number];
type Run = Parameters<typeof groupByRun>[0][number];

const at = (min: number) => new Date(Date.UTC(2026, 9, 15, 7, min));

const run = (id: string, startMin: number, over: Partial<Run> = {}): Run => ({
  id,
  kind: 'issue',
  status: 'completed',
  startedAt: at(startMin),
  finishedAt: at(startMin + 30),
  ordinal: startMin + 1,
  group: null,
  ...over,
});

function row(
  runId: string,
  phase: string,
  attempt: number,
  startMin: number,
  over: Partial<Row> = {},
): Row {
  return {
    id: `${runId}-${phase}-${attempt}`,
    projectId: 'p1',
    runId,
    issueId: 'i1',
    jobId: null,
    agentSessionId: null,
    phase,
    attempt,
    source: 'agent',
    outcome: 'ok',
    artifact: null,
    handoff: null,
    handoffAt: null,
    startedAt: at(startMin),
    endedAt: at(startMin + 1),
    ...over,
  };
}

describe('groupByRun', () => {
  it('answers no runs for an issue that never ran', () => {
    expect(groupByRun([], [], 'i1')).toEqual({ runs: [] });
  });

  it('keeps a run that recorded no phase, with no attempts, rather than hiding it', () => {
    const { runs } = groupByRun([run('r1', 0, { status: 'failed' })], [], 'i1');
    expect(runs).toEqual([
      expect.objectContaining({ runId: 'r1', status: 'failed', attempts: [] }),
    ]);
  });

  it('puts the newest run first and each run’s attempts in the order they started', () => {
    const { runs } = groupByRun(
      [run('r1', 0), run('r2', 30)],
      [
        row('r2', 'implement', 1, 40),
        row('r1', 'implement', 2, 20),
        row('r2', 'plan', 1, 30),
        row('r1', 'plan', 1, 0),
        row('r1', 'implement', 1, 10),
      ],
      'i1',
    );
    expect(runs.map((r) => r.runId)).toEqual(['r2', 'r1']);
    expect(runs[1]?.attempts.map((a) => `${a.phase}#${a.attempt}`)).toEqual([
      'plan#1',
      'implement#1',
      'implement#2',
    ]);
  });

  it('carries the handoff with the attempt that left it, and an open attempt as open with no span', () => {
    const handoff = { step: 'drive', summary: 'pushed the branch' };
    const { runs } = groupByRun(
      [run('r1', 0, { status: 'running', finishedAt: null })],
      [
        row('r1', 'drive', 1, 0, { handoff, handoffAt: at(5) }),
        row('r1', 'review', 1, 6, { outcome: null, endedAt: null }),
      ],
      'i1',
    );
    expect(runs[0]?.attempts[0]).toMatchObject({ handoff, handoffAt: at(5), durationSeconds: 60 });
    expect(runs[0]?.attempts[1]).toMatchObject({
      outcome: null,
      endedAt: null,
      handoff: null,
      durationSeconds: null,
    });
  });

  it('gives an attempt only its handoff recorded no span, never a zero one', () => {
    const { runs } = groupByRun(
      [run('r1', 0)],
      [row('r1', 'code', 1, 3, { handoff: { step: 'code' }, handoffAt: at(3), endedAt: at(3) })],
      'i1',
    );
    expect(runs[0]?.attempts[0]?.durationSeconds).toBeNull();
  });

  it('answers the run’s cost where usage was recorded and null where none was', () => {
    const { runs } = groupByRun([run('r1', 0), run('r2', 30)], [], 'i1', new Map([['r1', 1.25]]));
    expect(runs.map((r) => [r.runId, r.costUsd])).toEqual([
      ['r2', null],
      ['r1', 1.25],
    ]);
  });

  it('keeps the number each run was given over all of the issue’s runs', () => {
    const { runs } = groupByRun(
      [run('r51', 0, { ordinal: 51 }), run('r52', 30, { ordinal: 52 })],
      [],
      'i1',
    );
    expect(runs.map((r) => [r.runId, r.ordinal])).toEqual([
      ['r52', 52],
      ['r51', 51],
    ]);
  });

  it('holds, on a group run, only the attempts naming this issue', () => {
    const { runs } = groupByRun(
      [run('g1', 0, { kind: 'system', group: ['ISS-1', 'ISS-2'] })],
      [
        row('g1', 'drive', 1, 0, { issueId: 'i1' }),
        row('g1', 'drive', 2, 5, { issueId: 'i2' }),
        row('g1', 'recall', 1, 1, { issueId: null }),
      ],
      'i1',
    );
    expect(runs[0]?.group).toEqual(['ISS-1', 'ISS-2']);
    expect(runs[0]?.attempts.map((a) => `${a.phase}#${a.attempt}`)).toEqual(['drive#1']);
  });

  it('holds, on a run of the issue alone, an attempt that names no issue', () => {
    const { runs } = groupByRun(
      [run('r1', 0)],
      [row('r1', 'recall', 1, 0, { issueId: null })],
      'i1',
    );
    expect(runs[0]?.attempts).toHaveLength(1);
  });
});
