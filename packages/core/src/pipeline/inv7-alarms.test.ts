import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('../db/client.js', () => ({
  db: { execute: (...args: unknown[]) => dbExecute(...args) },
}));

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
const resolveWedgeMock = vi.fn(async (_id: string) => 0);
vi.mock('./wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
  resolvePipelineWedge: (id: string) => resolveWedgeMock(id),
  reviewRoundsWedgeEntityId: (runId: string) => `rounds:${runId}`,
  pausedRunWedgeEntityId: (runId: string) => `paused:${runId}`,
}));

vi.mock('../jobs/hold.js', () => ({
  HOLD_PAYLOAD_KEY: '__hold',
  holdResumesItself: (reason: string | null) =>
    reason === 'all_devices_exhausted' ||
    reason === 'monthly_budget_exhausted' ||
    reason === 'verify_unavailable',
}));

vi.mock('./run-pause.js', () => ({
  pauseResumesItself: (_reason: string | null) => false,
}));

const gateReasons = vi.fn(async (_projectId: string) => new Map<string, string>());
vi.mock('../jobs/queued-gates.js', () => ({
  gateReasonsForQueuedJobs: (projectId: string) => gateReasons(projectId),
}));

vi.mock('../jobs/loop-monitor.js', () => ({ RESULT_QUIET_MINUTES: 60 }));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  alarmAgedHolds,
  alarmPausedRunsWithQueuedWork,
  alarmRejectionStreaks,
  alarmStalledQueuedJobs,
  HOLD_AGE_ALARM_MS,
  PAUSED_RUN_ALARM_MS,
} = await import('./inv7-alarms.js');

const NOW = new Date('2026-08-14T12:00:00.000Z');

function wedge(call = 0): Record<string, string> {
  return emitWedgeMock.mock.calls[call]?.[0] as unknown as Record<string, string>;
}

beforeEach(() => {
  dbExecute.mockReset();
  dbExecute.mockResolvedValue([]);
  emitWedgeMock.mockClear();
  resolveWedgeMock.mockClear();
  gateReasons.mockReset();
  gateReasons.mockResolvedValue(new Map());
});

describe('alarmAgedHolds', () => {
  const heldRow = {
    job_id: 'job-1',
    project_id: 'proj-1',
    issue_id: 'iss-1',
    job_type: 'code',
    hold_reason: 'all_devices_exhausted',
    held_at: '2026-08-14T01:00:00.000Z',
    iss_seq: 41,
  };

  it('surfaces one wedge per aged hold, naming the issue and the hold reason', async () => {
    dbExecute.mockResolvedValueOnce([heldRow]);

    const res = await alarmAgedHolds(NOW);

    expect(res.alerted).toBe(1);
    expect(wedge().issueId).toBe('iss-1');
    expect(wedge().entityId).toBe('job-1');
    expect(wedge().title).toContain('ISS-41');
    expect(wedge().reason).toContain('all_devices_exhausted');
  });

  it('tells the reader to fix the condition, never to move the issue', async () => {
    dbExecute.mockResolvedValueOnce([heldRow]);

    await alarmAgedHolds(NOW);

    const body = `${wedge().summary} ${wedge().nextStep} ${wedge().action}`;
    expect(body).toContain('resumes on its own');
    expect(body).not.toMatch(/move (this|the) issue/i);
    expect(body).not.toMatch(/clear the park/i);
    expect(wedge().summary).toContain('never moved');
  });

  it('tells the reader a permanent hold will not clear itself', async () => {
    dbExecute.mockResolvedValueOnce([{ ...heldRow, hold_reason: 'non_retryable_terminal' }]);

    await alarmAgedHolds(NOW);

    const body = `${wedge().summary} ${wedge().nextStep} ${wedge().action}`;
    expect(body).not.toContain('resumes on its own');
    expect(wedge().nextStep).toMatch(/will NOT clear by itself/);
    expect(wedge().nextStep).toMatch(/cancel this step and move the issue on/);
  });

  it('writes nothing and emits nothing when no hold is old enough', async () => {
    const res = await alarmAgedHolds(NOW);

    expect(res.alerted).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('cuts off at now minus the threshold, not at now', async () => {
    await alarmAgedHolds(NOW);

    const params = dbExecute.mock.calls[0]?.[0] as unknown as { queryChunks?: unknown[] };
    const rendered = JSON.stringify(params);
    expect(rendered).toContain(new Date(NOW.getTime() - HOLD_AGE_ALARM_MS).toISOString());
    expect(rendered).not.toContain(NOW.toISOString());
  });

  it('falls back to a generic label when the job has no issue', async () => {
    dbExecute.mockResolvedValueOnce([{ ...heldRow, issue_id: null, iss_seq: null }]);

    await alarmAgedHolds(NOW);

    expect(wedge().title).toContain('A step');
    expect(wedge().title).not.toContain('ISS-');
  });
});

describe('alarmStalledQueuedJobs', () => {
  const candidate = {
    job_id: 'job-1',
    project_id: 'proj-1',
    issue_id: 'iss-1',
    job_type: 'code',
    created_at: '2026-08-14T09:00:00.000Z',
    iss_seq: 42,
  };

  it('surfaces a job the dispatcher says it could run', async () => {
    dbExecute.mockResolvedValue([candidate]);

    const result = await alarmStalledQueuedJobs(NOW);

    expect(result.alerted).toBe(1);
    expect(wedge()).toMatchObject({
      projectId: 'proj-1',
      issueId: 'iss-1',
      entityId: 'job-1',
      reason: 'queued_over_60m:no_gate',
    });
    expect(wedge().title).toContain('ISS-42');
  });

  it('stays silent when a gate explains the wait, which is what waiting for a runner looks like', async () => {
    dbExecute.mockResolvedValue([candidate]);
    gateReasons.mockResolvedValue(new Map([['job-1', 'runner_stale']]));

    const result = await alarmStalledQueuedJobs(NOW);

    expect(result.alerted).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('reads the gate once per project, not once per job', async () => {
    dbExecute.mockResolvedValue([
      candidate,
      { ...candidate, job_id: 'job-2', iss_seq: 43 },
      { ...candidate, job_id: 'job-3', project_id: 'proj-2', iss_seq: 44 },
    ]);

    await alarmStalledQueuedJobs(NOW);

    expect(gateReasons).toHaveBeenCalledTimes(2);
  });
});

describe('alarmRejectionStreaks', () => {
  const streakRow = {
    run_id: 'run-9',
    project_id: 'proj-1',
    issue_id: 'iss-3',
    iss_seq: 878,
    title: 'noProgressRounds has teeth',
    streak: 5,
    threshold: 5,
  };

  it('surfaces the streak and the threshold, naming the issue', async () => {
    dbExecute.mockResolvedValueOnce([streakRow]);

    const res = await alarmRejectionStreaks();

    expect(res.alerted).toBe(1);
    expect(wedge().issueId).toBe('iss-3');
    expect(wedge().title).toContain('ISS-878');
    expect(wedge().title).toContain('5 times in a row');
    expect(wedge().reason).toBe('rejection_streak:5/5');
  });

  it('says it counted consecutive rejections, not total rounds', async () => {
    dbExecute.mockResolvedValueOnce([streakRow]);

    await alarmRejectionStreaks();

    expect(wedge().summary).toContain('CONSECUTIVE');
    expect(wedge().summary).toContain('since the last approval');
    expect(wedge().summary).toContain('normal work');
  });

  it('rests the alert on the reviewer findings, with churn only as the agent account', async () => {
    dbExecute.mockResolvedValueOnce([streakRow]);

    await alarmRejectionStreaks();

    expect(wedge().summary).toContain("reviewer's own verdicts");
    expect(wedge().nextStep).toContain('findings');
    expect(wedge().nextStep).toContain('it believes');
  });

  it('keys the wedge on the run, never on the issue id', async () => {
    dbExecute.mockResolvedValueOnce([streakRow]);

    await alarmRejectionStreaks();

    expect(wedge().entity).toBe('run');
    expect(wedge().entityId).toBe('rounds:run-9');
    expect(wedge().entityId).not.toContain('iss-3');
  });

  it('names nothing blocked — the alert is visibility only', async () => {
    dbExecute.mockResolvedValueOnce([streakRow]);

    await alarmRejectionStreaks();

    expect(wedge().action).toContain('nothing is blocked');
  });

  it('falls back to a generic label when the issue has no sequence number', async () => {
    dbExecute.mockResolvedValueOnce([{ ...streakRow, iss_seq: null, title: null }]);

    await alarmRejectionStreaks();

    expect(wedge().title).toContain('An issue');
    expect(wedge().title).not.toContain('ISS-');
  });

  it('emits nothing when no run has reached its threshold', async () => {
    const res = await alarmRejectionStreaks();

    expect(res.alerted).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });
});

describe('alarmPausedRunsWithQueuedWork (ISS-879)', () => {
  const pausedRow = {
    run_id: 'run-1',
    project_id: 'proj-1',
    issue_id: 'iss-1',
    pause_reason: 'missing_skill:open',
    paused_since: '2026-08-12T01:15:00.000Z',
    queued_jobs: 2,
    queued_types: 'plan, triage',
    iss_seq: 848,
  };

  it('selects only paused runs that still have queued work, past the threshold', async () => {
    dbExecute.mockResolvedValueOnce([]);

    const res = await alarmPausedRunsWithQueuedWork(NOW);

    expect(res.alerted).toBe(0);
    const text = JSON.stringify(
      dbExecute.mock.calls[0]?.[0] as unknown as { queryChunks?: unknown[] },
    ).replace(/\\n/g, ' ');
    expect(text).toMatch(/r\.status\s*=\s*'paused'/);
    expect(text).not.toMatch(/'running'/);
    expect(text).toMatch(/j\.status\s*=\s*'queued'/);
    expect(text).toMatch(/LEFT JOIN jobs j/);
    expect(text).toMatch(/r\.updated_at\s*</);
    expect(emitWedgeMock).not.toHaveBeenCalled();
  });

  it('emits one run-keyed wedge naming the issue, the pause reason and the frozen steps', async () => {
    dbExecute.mockResolvedValueOnce([pausedRow]);

    const res = await alarmPausedRunsWithQueuedWork(NOW);

    expect(res.alerted).toBe(1);
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    const w = wedge();
    expect(w.entity).toBe('run');
    expect(w.entityId).toBe('paused:run-1');
    expect(w.issueId).toBe('iss-1');
    expect(w.reason).toContain('missing_skill:open');
    expect(w.title).toContain('ISS-848');
    expect(w.summary).toContain('plan, triage');
  });

  it('does not promise a resume for a pause nothing in this build clears', async () => {
    dbExecute.mockResolvedValueOnce([{ ...pausedRow, pause_reason: 'stage_stalled:released' }]);

    await alarmPausedRunsWithQueuedWork(NOW);

    expect(wedge().nextStep).toContain('will NOT resume');
    expect(wedge().action).toContain('waiting on you');
  });

  it('reports an operator pause as one, rather than inventing a machine reason', async () => {
    dbExecute.mockResolvedValueOnce([{ ...pausedRow, pause_reason: null }]);

    await alarmPausedRunsWithQueuedWork(NOW);

    expect(wedge().reason).toContain('operator');
    expect(wedge().summary).toContain('operator pause');
    expect(wedge().nextStep).toContain('will NOT resume');
  });

  it('defaults its threshold to the aged-hold scale — the same judgement about the same wait', () => {
    expect(PAUSED_RUN_ALARM_MS).toBe(HOLD_AGE_ALARM_MS);
  });
});

describe('alarmPausedRunsWithQueuedWork — clearing its own claim (ISS-879)', () => {
  const base = {
    run_id: 'run-9',
    project_id: 'proj-1',
    issue_id: 'iss-9',
    pause_reason: 'stage_stalled:testing',
    paused_since: '2026-08-12T01:15:00.000Z',
    queued_types: null,
    iss_seq: 91,
  };

  it('resolves the wedge for a paused run whose queue has emptied', async () => {
    dbExecute.mockResolvedValueOnce([{ ...base, queued_jobs: 0 }]);

    const res = await alarmPausedRunsWithQueuedWork(NOW);

    expect(res.alerted).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
    expect(resolveWedgeMock).toHaveBeenCalledWith('paused:run-9');
  });

  it('does not resolve while steps are still frozen', async () => {
    dbExecute.mockResolvedValueOnce([{ ...base, queued_jobs: 2, queued_types: 'code, review' }]);

    const res = await alarmPausedRunsWithQueuedWork(NOW);

    expect(res.alerted).toBe(1);
    expect(resolveWedgeMock).not.toHaveBeenCalled();
  });

  it('counts only the runs it alarmed, not every paused run it looked at', async () => {
    dbExecute.mockResolvedValueOnce([
      { ...base, run_id: 'run-a', queued_jobs: 0 },
      { ...base, run_id: 'run-b', queued_jobs: 1, queued_types: 'plan' },
      { ...base, run_id: 'run-c', queued_jobs: 0 },
    ]);

    const res = await alarmPausedRunsWithQueuedWork(NOW);

    expect(res.alerted).toBe(1);
    expect(emitWedgeMock).toHaveBeenCalledTimes(1);
    expect(resolveWedgeMock).toHaveBeenCalledTimes(2);
  });
});
