import { beforeEach, describe, expect, it, vi } from 'vitest';

const limit = vi.fn();
const orderBy = vi.fn(() => ({ limit }));
const where = vi.fn(() => ({ orderBy }));
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

const returning = vi.fn();
const updateWhere = vi.fn(() => ({ returning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const update = vi.fn(() => ({ set: updateSet }));

vi.mock('../db/client.js', () => ({
  db: { select, update },
}));

const broadcastRunnerChanged = vi.fn();
vi.mock('./apply-runner-limit.js', () => ({ broadcastRunnerChanged }));

const { parsePreflightCheck, maybeQuarantineRunner, clearRunnerQuarantine } = await import(
  './quarantine.js'
);

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUNNER_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB_CURRENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => {
  limit.mockReset();
  orderBy.mockClear();
  where.mockClear();
  from.mockClear();
  select.mockClear();
  updateWhere.mockClear();
  updateSet.mockClear();
  update.mockClear();
  returning.mockReset();
  returning.mockResolvedValue([]);
  broadcastRunnerChanged.mockClear();
});

describe('parsePreflightCheck', () => {
  it('extracts the check token from a box-attributable error', () => {
    expect(
      parsePreflightCheck(
        'preflight_failed: push_credentials: git@github.com: Permission denied (publickey).',
      ),
    ).toBe('push_credentials');
  });

  it('trims whitespace around the token', () => {
    expect(parsePreflightCheck('preflight_failed:  work_tree : dirty checkout')).toBe('work_tree');
  });

  it('returns null for a non-box-attributable error', () => {
    expect(parsePreflightCheck('[RESULT_ERROR] success: spend limit hit')).toBeNull();
    expect(parsePreflightCheck('job_failed')).toBeNull();
  });

  it('returns null for null/undefined/empty', () => {
    expect(parsePreflightCheck(null)).toBeNull();
    expect(parsePreflightCheck(undefined)).toBeNull();
    expect(parsePreflightCheck('')).toBeNull();
  });

  it('returns null when the prefix carries no check token', () => {
    expect(parsePreflightCheck('preflight_failed:')).toBeNull();
    expect(parsePreflightCheck('preflight_failed:   ')).toBeNull();
  });
});

describe('maybeQuarantineRunner', () => {
  const CURRENT_ERROR = 'preflight_failed: push_credentials: permission denied';

  it('does nothing when runnerId is absent', async () => {
    expect(await maybeQuarantineRunner(null, PROJECT_A, JOB_CURRENT, CURRENT_ERROR)).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('does nothing when the current failure is not box-attributable', async () => {
    expect(
      await maybeQuarantineRunner(RUNNER_A, PROJECT_A, JOB_CURRENT, 'job_failed: agent crashed'),
    ).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('trips quarantine when the last N-1 prior jobs are all failed with the same check (default streak 3)', async () => {
    limit.mockResolvedValueOnce([
      { status: 'failed', error: 'preflight_failed: push_credentials: x' },
      { status: 'failed', error: 'preflight_failed: push_credentials: y' },
    ]);
    const tripped = await maybeQuarantineRunner(RUNNER_A, PROJECT_A, JOB_CURRENT, CURRENT_ERROR);
    expect(tripped).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        quarantineReason: expect.stringContaining('push_credentials'),
      }),
    );
    expect(broadcastRunnerChanged).toHaveBeenCalledWith(PROJECT_A, RUNNER_A);
  });

  it('excludes the current job id from the prior-failures lookback (race-free)', async () => {
    limit.mockResolvedValueOnce([
      { status: 'failed', error: 'preflight_failed: push_credentials: x' },
      { status: 'failed', error: 'preflight_failed: push_credentials: y' },
    ]);
    await maybeQuarantineRunner(RUNNER_A, PROJECT_A, JOB_CURRENT, CURRENT_ERROR);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('does not trip when a differing preflight check appears in the streak', async () => {
    limit.mockResolvedValueOnce([
      { status: 'failed', error: 'preflight_failed: push_credentials: x' },
      { status: 'failed', error: 'preflight_failed: hooks_path: y' },
    ]);
    const tripped = await maybeQuarantineRunner(RUNNER_A, PROJECT_A, JOB_CURRENT, CURRENT_ERROR);
    expect(tripped).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not trip when one of the prior jobs is not box-attributable', async () => {
    limit.mockResolvedValueOnce([
      { status: 'failed', error: 'preflight_failed: push_credentials: x' },
      { status: 'failed', error: '[RESULT_ERROR] success: spend limit hit' },
    ]);
    const tripped = await maybeQuarantineRunner(RUNNER_A, PROJECT_A, JOB_CURRENT, CURRENT_ERROR);
    expect(tripped).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not trip when an intervening success (done) breaks the streak', async () => {
    // A `done` row would never satisfy the 'failed'|'done' terminal filter as
    // an all-failed streak — the query only returns failed/done rows, so a
    // `done` in the last N-1 immediately fails the all-failed check.
    limit.mockResolvedValueOnce([
      { status: 'done', error: null },
      { status: 'failed', error: 'preflight_failed: push_credentials: y' },
    ]);
    const tripped = await maybeQuarantineRunner(RUNNER_A, PROJECT_A, JOB_CURRENT, CURRENT_ERROR);
    expect(tripped).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not trip when fewer than N-1 prior terminal jobs exist', async () => {
    limit.mockResolvedValueOnce([
      { status: 'failed', error: 'preflight_failed: push_credentials: x' },
    ]);
    const tripped = await maybeQuarantineRunner(RUNNER_A, PROJECT_A, JOB_CURRENT, CURRENT_ERROR);
    expect(tripped).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('never throws when the DB query fails (best-effort contract)', async () => {
    limit.mockRejectedValueOnce(new Error('db down'));
    await expect(
      maybeQuarantineRunner(RUNNER_A, PROJECT_A, JOB_CURRENT, CURRENT_ERROR),
    ).resolves.toBe(false);
  });
});

describe('clearRunnerQuarantine', () => {
  it('does nothing when runnerId is absent', async () => {
    await clearRunnerQuarantine(null, PROJECT_A);
    expect(update).not.toHaveBeenCalled();
  });

  it('clears quarantine and broadcasts when a row was actually cleared', async () => {
    returning.mockResolvedValueOnce([{ id: RUNNER_A }]);
    await clearRunnerQuarantine(RUNNER_A, PROJECT_A);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ quarantinedUntil: null, quarantineReason: null }),
    );
    expect(broadcastRunnerChanged).toHaveBeenCalledWith(PROJECT_A, RUNNER_A);
  });

  it('no-ops (no broadcast) when the runner was not quarantined', async () => {
    returning.mockResolvedValueOnce([]);
    await clearRunnerQuarantine(RUNNER_A, PROJECT_A);
    expect(broadcastRunnerChanged).not.toHaveBeenCalled();
  });

  it('never throws when the DB update fails (best-effort contract)', async () => {
    returning.mockRejectedValueOnce(new Error('db down'));
    await expect(clearRunnerQuarantine(RUNNER_A, PROJECT_A)).resolves.toBeUndefined();
  });
});
