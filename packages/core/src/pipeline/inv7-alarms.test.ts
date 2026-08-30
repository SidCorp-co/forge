import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('../db/client.js', () => ({
  db: { execute: (...args: unknown[]) => dbExecute(...args) },
}));

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
  reviewRoundsWedgeEntityId: (runId: string) => `rounds:${runId}`,
}));

// cm:edge contract -> packages/core/src/jobs/hold.ts — HOLD_PAYLOAD_KEY must stay `__hold` and this `holdResumesItself` stub must keep AUTO_RELEASE_REASONS' membership; importing the real module pulls queue/boss.ts, whose load-time env validation throws under vitest. hold.test.ts owns the real predicate — this stub only has to agree with it.
vi.mock('../jobs/hold.js', () => ({
  HOLD_PAYLOAD_KEY: '__hold',
  holdResumesItself: (reason: string | null) =>
    reason === 'all_devices_exhausted' ||
    reason === 'monthly_budget_exhausted' ||
    reason === 'verify_unavailable',
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
  alarmRejectionStreaks,
  alarmStalledQueuedJobs,
  HOLD_AGE_ALARM_MS,
} = await import('./inv7-alarms.js');

const NOW = new Date('2026-08-14T12:00:00.000Z');

function wedge(call = 0): Record<string, string> {
  return emitWedgeMock.mock.calls[call]?.[0] as unknown as Record<string, string>;
}

beforeEach(() => {
  dbExecute.mockReset();
  dbExecute.mockResolvedValue([]);
  emitWedgeMock.mockClear();
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
