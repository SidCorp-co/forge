/**
 * ISS-1273 — the lane a run was opened on, and what its step may mean there.
 *
 * Pure, so every arm is exercised without the rollup's mocked queries; that the summary composes
 * them is `runs-rollup.test.ts`'s one case.
 */

import { describe, expect, it } from 'vitest';
import { laneOf, noStepDetail, runIssuesOf, stepOf } from './runs-lane.js';

type RunRow = Parameters<typeof laneOf>[0];

function run(over: Partial<RunRow> = {}): RunRow {
  return { issueId: null, metadata: {}, ...over } as RunRow;
}

describe('laneOf', () => {
  it('a run naming an issue is on the job lane', () => {
    expect(laneOf(run({ issueId: 'iss-1' }))).toBe('job');
  });

  it('a run a box opened over a group is on the run-session lane', () => {
    expect(laneOf(run({ metadata: { type: 'run_session', runIssues: ['ISS-1'] } }))).toBe(
      'run_session',
    );
  });

  it('a one-shot run belonging to neither reads `system`, never a guessed lane', () => {
    expect(laneOf(run())).toBe('system');
    expect(laneOf(run({ metadata: { type: 'release' } }))).toBe('system');
  });

  it('reads the lane off the metadata the opener wrote, not off the null column', () => {
    expect(laneOf(run({ issueId: 'iss-1', metadata: { type: 'run_session' } }))).toBe('job');
  });
});

describe('runIssuesOf', () => {
  it('returns the group a run-session run was opened over', () => {
    expect(runIssuesOf({ runIssues: ['ISS-1273', 'ISS-1271'] })).toEqual(['ISS-1273', 'ISS-1271']);
  });

  it('returns nothing for a run that carries no group', () => {
    expect(runIssuesOf({})).toEqual([]);
    expect(runIssuesOf(null)).toEqual([]);
  });

  it('drops a member that is not a key rather than carrying it through', () => {
    expect(runIssuesOf({ runIssues: ['ISS-1', 7, null] })).toEqual(['ISS-1']);
  });

  it('does not read a `runIssues` that is not an array as a group of one', () => {
    expect(runIssuesOf({ runIssues: 'ISS-1' })).toEqual([]);
  });
});

describe('stepOf', () => {
  it('takes the column where the job lane stamped one', () => {
    expect(stepOf('job', 'code')).toEqual({ source: 'run_column', step: 'code', detail: null });
  });

  it('takes the open phase where the column is null on the run-session lane', () => {
    expect(stepOf('run_session', null, 'implement')).toEqual({
      source: 'phase_journal',
      step: 'implement',
      detail: null,
    });
  });

  it('prefers the stamped column over a phase on the job lane, where the column has a writer', () => {
    expect(stepOf('job', 'code', 'implement').step).toBe('code');
  });

  // ISS-1273 — `runs.ts:setCurrentStep` never runs on the run-session lane, so a value in that
  // column is stale or hand-repaired. Reporting it would credit a writer that does not exist.
  it('refuses a stale column on the run-session lane rather than crediting the job lane writer', () => {
    expect(stepOf('run_session', 'code')).toEqual({
      source: 'none',
      step: null,
      detail: expect.stringContaining('no phase open'),
    });
  });

  it('takes the open phase over a stale column on the run-session lane', () => {
    expect(stepOf('run_session', 'code', 'implement')).toEqual({
      source: 'phase_journal',
      step: 'implement',
      detail: null,
    });
  });

  it('keeps the column on the system lane, where a release does stamp it', () => {
    expect(stepOf('system', 'deploy').source).toBe('run_column');
  });

  // ISS-1273 — a null step with nothing saying why is the shape this issue was filed against.
  it('says why it holds no step for a run-session run with no phase open', () => {
    const step = stepOf('run_session', null);
    expect(step.source).toBe('none');
    expect(step.step).toBeNull();
    expect(step.detail).toContain('no phase open');
  });

  it('says why it holds no step for a job-lane run nothing has stamped yet', () => {
    expect(stepOf('job', null).detail).toContain('no pipeline step has been stamped');
  });

  it('gives every lane its own sentence rather than one shared shrug', () => {
    const said = new Set(
      (['job', 'run_session', 'system'] as const).map((lane) => noStepDetail(lane)),
    );
    expect(said.size).toBe(3);
  });
});
