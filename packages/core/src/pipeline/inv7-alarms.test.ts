import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('../db/client.js', () => ({
  db: { execute: (...args: unknown[]) => dbExecute(...args) },
}));

const emitWedgeMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./wedge.js', () => ({
  emitPipelineWedge: (...args: unknown[]) => emitWedgeMock(...(args as [])),
}));

// cm:edge contract -> packages/core/src/jobs/hold.ts — HOLD_PAYLOAD_KEY must stay `__hold` and this `holdResumesItself` stub must keep AUTO_RELEASE_REASONS' membership; importing the real module pulls queue/boss.ts, whose load-time env validation throws under vitest. hold.test.ts owns the real predicate — this stub only has to agree with it.
vi.mock('../jobs/hold.js', () => ({
  HOLD_PAYLOAD_KEY: '__hold',
  holdResumesItself: (reason: string | null) =>
    reason === 'all_devices_exhausted' ||
    reason === 'monthly_budget_exhausted' ||
    reason === 'verify_unavailable',
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { alarmAgedHolds, alarmChurningIssues, HOLD_AGE_ALARM_MS } = await import('./inv7-alarms.js');

const NOW = new Date('2026-08-14T12:00:00.000Z');

function wedge(call = 0): Record<string, string> {
  return emitWedgeMock.mock.calls[call]?.[0] as unknown as Record<string, string>;
}

beforeEach(() => {
  dbExecute.mockReset();
  dbExecute.mockResolvedValue([]);
  emitWedgeMock.mockClear();
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
