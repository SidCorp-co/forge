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

// cm:edge contract -> packages/core/src/jobs/hold.ts — HOLD_PAYLOAD_KEY must stay `__hold` and this `holdResumesItself` stub must keep AUTO_RELEASE_REASONS' membership; importing the real module pulls queue/boss.ts, whose load-time env validation throws under vitest. hold.test.ts owns the real predicate — this stub only has to agree with it.
vi.mock('../jobs/hold.js', () => ({
  HOLD_PAYLOAD_KEY: '__hold',
  holdResumesItself: (reason: string | null) =>
    reason === 'all_devices_exhausted' ||
    reason === 'monthly_budget_exhausted' ||
    reason === 'verify_unavailable',
}));

// cm:edge contract -> packages/core/src/pipeline/run-pause.ts — this stub must keep MACHINE_RESUMED_PAUSE_KINDS' membership; importing the real module pulls ws/server.js, whose load-time env validation throws under vitest. run-pause.test.ts owns the real predicate and paused-run-queued-work-e2e.test.ts exercises it unmocked — this stub only has to agree with both.
vi.mock('./run-pause.js', () => ({
  pauseResumesItself: (reason: string | null) => (reason ?? '').startsWith('missing_skill'),
}));

const gateReasons = vi.fn(async (_projectId: string) => new Map<string, string>());
vi.mock('../jobs/dispatch-gates.js', () => ({
  gateReasonsForQueuedJobs: (projectId: string) => gateReasons(projectId),
}));

// cm:edge contract -> packages/core/src/jobs/loop-monitor.ts — RESULT_QUIET_MINUTES sets this alarm's default threshold; importing the real module pulls queue/boss.ts, whose load-time env validation throws under vitest
vi.mock('../jobs/loop-monitor.js', () => ({ RESULT_QUIET_MINUTES: 60 }));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  alarmAgedHolds,
  alarmChurningIssues,
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

  // cm:guard the copy is the whole deliverable of this pass (RFC 0002 INV-7) — a hold means the pipeline is waiting on a MACHINE, so a wedge that asks the reader to move the issue re-creates in the notification the intervention the RFC removed from the state machine
  it('tells the reader to fix the condition, never to move the issue', async () => {
    dbExecute.mockResolvedValueOnce([heldRow]);

    await alarmAgedHolds(NOW);

    const body = `${wedge().summary} ${wedge().nextStep} ${wedge().action}`;
    expect(body).toContain('resumes on its own');
    expect(body).not.toMatch(/move (this|the) issue/i);
    expect(body).not.toMatch(/clear the park/i);
    expect(wedge().summary).toContain('never moved');
  });

  // cm:guard a permanent hold must NOT be described as self-resuming — `non_retryable_terminal` and `retry_rounds_exhausted` have `autoRelease: false`, so this wedge was telling operators "no action needed, it resumes on its own" about steps that would never run again
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

describe('alarmChurningIssues', () => {
  const churnRow = {
    issue_id: 'iss-2',
    project_id: 'proj-1',
    iss_seq: 55,
    title: 'Login redirect 500s',
    reopen_count: 6,
    threshold: 5,
  };

  it('surfaces the count and the threshold without asserting the rounds were wasted', async () => {
    dbExecute.mockResolvedValueOnce([churnRow]);

    const res = await alarmChurningIssues();

    expect(res.alerted).toBe(1);
    expect(wedge().title).toContain('6 times');
    expect(wedge().summary).toContain('not a verdict');
    expect(wedge().summary).toContain('churn');
  });

  // cm:guard `entity` must stay `issue` here — the dedup key is `wedge:<entityId>`, so an issue id passed under `entity:'job'` still dedupes correctly while telling every consumer a job id that does not exist
  it('keys the wedge on the issue, since no job is stuck', async () => {
    dbExecute.mockResolvedValueOnce([churnRow]);

    await alarmChurningIssues();

    expect(wedge().entity).toBe('issue');
    expect(wedge().entityId).toBe('iss-2');
  });

  it('names nothing blocked — the alert is visibility only', async () => {
    dbExecute.mockResolvedValueOnce([churnRow]);

    await alarmChurningIssues();

    expect(wedge().action).toContain('nothing is blocked');
  });

  it('emits nothing when no issue has reached its threshold', async () => {
    const res = await alarmChurningIssues();

    expect(res.alerted).toBe(0);
    expect(emitWedgeMock).not.toHaveBeenCalled();
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

  // cm:guard the copy must name WHICH count reached the threshold — `noProgressRounds` backs total reopens in `alarmChurningIssues` and consecutive rejections here, and a wedge that prints only the number leaves the reader unable to tell whether five rounds were wasted or five different blockers were fixed
  it('says it counted consecutive rejections, not total rounds', async () => {
    dbExecute.mockResolvedValueOnce([streakRow]);

    await alarmRejectionStreaks();

    expect(wedge().summary).toContain('CONSECUTIVE');
    expect(wedge().summary).toContain('since the last approval');
    expect(wedge().summary).toContain('normal work');
  });

  // cm:guard the alert's authority is that the reviewer wrote the verdicts, so the copy must not present `sessionContext.churn` as its basis — churn is agent-written, and an alert that rested on it would let the agent decide whether it is churning
  it('rests the alert on the reviewer findings, with churn only as the agent account', async () => {
    dbExecute.mockResolvedValueOnce([streakRow]);

    await alarmRejectionStreaks();

    expect(wedge().summary).toContain("reviewer's own verdicts");
    expect(wedge().nextStep).toContain('findings');
    expect(wedge().nextStep).toContain('it believes');
  });

  // cm:guard the entity must be the RUN under the `rounds:` namespace — `alarmChurningIssues` already emits under `wedge:<issueId>`, and sharing that key would let either pass silence the other while an approve resolved the wrong one
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

  // cm:guard the SQL must stay scoped to `paused` — this is the whole discriminator. A queued job under a RUNNING run is already owned by another pass, and reaching for it here rebuilds the age-based shape a human rejected on ISS-765 because a job queued behind the project cap looks identical to an orphan.
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
    // cm:guard the join MUST stay LEFT — an inner join never returns a paused run whose queue has emptied, which silently deletes the resolve arm while every "stays silent" assertion keeps passing
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

  // cm:guard the copy is taken from `pauseResumesItself`, never from the pass — `stage_stalled` has no resume path in this build, and a wedge that says it clears itself is the aged-hold failure repeated on the run axis
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

  // cm:guard the run leaving `paused` is NOT the only way the condition ends — an operator can cancel the queued steps and leave the pause standing, and the resolve subscriber only watches the run. A notification asserting "3 steps frozen" with zero frozen steps is the stranded row this arm exists to stop.
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
