import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({ env: { NODE_ENV: 'test' } }));

const dbExecute = vi.fn(async (..._args: unknown[]) => [] as Array<Record<string, unknown>>);
vi.mock('../db/client.js', () => ({ db: { execute: (...a: unknown[]) => dbExecute(...a) } }));

const closeRunMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('./runs.js', () => ({ closeRun: (...a: unknown[]) => closeRunMock(...a) }));

const loggerInfo = vi.fn();
const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    error: (...a: unknown[]) => loggerError(...a),
  },
}));

const { reapConcludedRuns, reapJoblessRuns } = await import('./runs-concluded.js');

type Row = {
  id: string;
  project_id: string;
  issue_id: string | null;
  kind: string;
  last_job_id: string;
  last_job_status: string;
};

function candidate(over: Partial<Row> = {}): Row {
  return {
    id: 'run-1',
    project_id: 'proj-1',
    issue_id: 'iss-1',
    kind: 'issue',
    last_job_id: 'job-1',
    last_job_status: 'done',
    ...over,
  };
}

describe('reapConcludedRuns (ISS-923)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbExecute.mockResolvedValue([]);
  });

  // cm:edge contract -> packages/core/tests/integration/concluded-run-reap-e2e.test.ts — this suite proves the outcome mapping and the per-row behaviour; the WHERE clause that PICKS the rows is SQL and a mocked db.execute is no evidence about it at all, so that file is where the predicate is judged. Neither half is the whole test.
  it.each([
    ['done', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ])('closes a run whose last job is `%s` as `%s`', async (jobStatus, outcome) => {
    dbExecute.mockResolvedValue([candidate({ last_job_status: jobStatus })]);

    const res = await reapConcludedRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(closeRunMock).toHaveBeenCalledWith('run-1', outcome);
  });

  // cm:guard the SELECT is the ONLY db call this module makes — the terminal write belongs to `closeRun`, and a second writer of a run's terminal status is what the ISS-923 invariant forbids on either axis.
  it('writes the terminal status only through closeRun', async () => {
    dbExecute.mockResolvedValue([candidate()]);

    await reapConcludedRuns(new Date());

    expect(dbExecute).toHaveBeenCalledTimes(1);
    expect(closeRunMock).toHaveBeenCalledTimes(1);
  });

  it('names the run and the project on every reap', async () => {
    dbExecute.mockResolvedValue([candidate()]);

    await reapConcludedRuns(new Date());

    const named = loggerInfo.mock.calls.find(
      ([fields]) => (fields as { runId?: string })?.runId === 'run-1',
    );
    expect(named?.[0]).toMatchObject({
      runId: 'run-1',
      projectId: 'proj-1',
      issueId: 'iss-1',
      kind: 'issue',
      lastJobId: 'job-1',
      outcome: 'completed',
    });
  });

  it('logs and skips a row that fails, and still closes the others', async () => {
    dbExecute.mockResolvedValue([candidate({ id: 'run-bad' }), candidate({ id: 'run-good' })]);
    closeRunMock.mockImplementationOnce(async () => {
      throw new Error('close blew up');
    });

    const res = await reapConcludedRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(closeRunMock).toHaveBeenCalledWith('run-good', 'completed');
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-bad', projectId: 'proj-1' }),
      expect.stringContaining('concluded run reap failed'),
    );
  });

  it('closes nothing and logs nothing when no run has concluded', async () => {
    const res = await reapConcludedRuns(new Date());

    expect(res.reaped).toBe(0);
    expect(closeRunMock).not.toHaveBeenCalled();
    expect(loggerInfo).not.toHaveBeenCalled();
  });
});

// cm:edge contract -> packages/core/tests/integration/jobless-run-reap-e2e.test.ts — this suite proves the outcome mapping only; which rows the pass ADMITS is SQL and a mocked db.execute is no evidence about it.
describe('reapJoblessRuns outcome mapping (ISS-654)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbExecute.mockResolvedValue([]);
  });

  const row = (over: Partial<{ any_completed: boolean; any_failed: boolean }> = {}) => ({
    id: 'run-1',
    project_id: 'proj-1',
    issue_id: 'iss-1',
    any_completed: false,
    any_failed: false,
    ...over,
  });

  // cm:guard `cancelled` when nothing ever ran, never `failed` — a fabricated failure lands in every success-rate metric that reads run outcomes.
  it.each([
    [{}, 'cancelled'],
    [{ any_completed: true }, 'completed'],
    [{ any_failed: true }, 'failed'],
    [{ any_completed: true, any_failed: true }, 'failed'],
  ])('maps %o to `%s`', async (over, outcome) => {
    dbExecute.mockResolvedValue([row(over)]);

    const res = await reapJoblessRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(closeRunMock).toHaveBeenCalledWith('run-1', outcome);
  });

  it('skips a row that throws and keeps closing the rest', async () => {
    dbExecute.mockResolvedValue([row(), { ...row(), id: 'run-2' }]);
    closeRunMock.mockRejectedValueOnce(new Error('nope'));

    const res = await reapJoblessRuns(new Date());

    expect(res.reaped).toBe(1);
    expect(loggerError).toHaveBeenCalledOnce();
  });
});
