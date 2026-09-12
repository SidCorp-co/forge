import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const select = vi.fn();
const transitionIssueStatus = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    execute: (...a: unknown[]) => execute(...a),
    select: (...a: unknown[]) => select(...a),
  },
}));
const warn = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn() },
}));
vi.mock('../issues/apply-transition.js', () => ({
  transitionIssueStatus: (...a: unknown[]) => transitionIssueStatus(...a),
  TransitionError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { HUMAN_PARK_STATUSES, RETURNABLE_FROM, returnIssuesForRun } from './run-issue-return.js';

const RUN = 'run-1';

/** One run row, as `readRun` reads it back. */
const RUN_STARTED = new Date('2026-09-13T10:00:00Z');

function runRow(keys: string[], statuses: Record<string, string>) {
  return [
    {
      project_id: 'proj-1',
      created_by: 'owner-1',
      started_at: RUN_STARTED.toISOString(),
      keys,
      statuses,
    },
  ];
}

/** The issue rows the drizzle select returns. */
function issueRows(rows: Array<{ seq: number; status: string; mergedAt?: Date }>) {
  select.mockReturnValue({
    from: () => ({
      where: async () =>
        rows.map((r) => ({
          id: `issue-${r.seq}`,
          projectId: 'proj-1',
          issSeq: r.seq,
          status: r.status,
          reopenCount: 0,
          mergedAt: r.mergedAt ?? null,
        })),
    }),
  });
}

beforeEach(() => {
  warn.mockReset();
  execute.mockReset();
  select.mockReset();
  transitionIssueStatus.mockReset();
  transitionIssueStatus.mockResolvedValue(undefined);
});

describe('returnIssuesForRun', () => {
  it('returns an issue to the status its run was claimed out of', async () => {
    execute.mockResolvedValue(runRow(['ISS-457'], { 'ISS-457': 'open' }));
    issueRows([{ seq: 457, status: 'in_progress' }]);

    const returned = await returnIssuesForRun(RUN, { reason: 'box silent' });

    expect(returned).toEqual([{ issueKey: 'ISS-457', from: 'in_progress', to: 'open' }]);
    expect(transitionIssueStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'issue-457' }),
      'open',
      expect.anything(),
      expect.objectContaining({ transitionReason: 'box silent', skip: true }),
    );
  });

  // cm:guard the target must leave the claimable set reachable — an issue stranded at `in_progress` is what ISS-457 sat at for 18 hours.
  it('moves the issue out of a status that reads as someone working it', async () => {
    execute.mockResolvedValue(runRow(['ISS-457'], { 'ISS-457': 'open' }));
    issueRows([{ seq: 457, status: 'in_progress' }]);

    await returnIssuesForRun(RUN, { reason: 'box silent' });

    const [, target] = transitionIssueStatus.mock.calls[0] as [unknown, string];
    expect(target).not.toBe('in_progress');
  });

  // cm:guard this is the red that fires if the park check is dropped from `returnIssuesForRun`.
  it.each(HUMAN_PARK_STATUSES)('leaves an issue a person parked at %s alone', async (parked) => {
    execute.mockResolvedValue(runRow(['ISS-406'], { 'ISS-406': 'open' }));
    issueRows([{ seq: 406, status: parked }]);

    const returned = await returnIssuesForRun(RUN, { reason: 'box silent' });

    expect(returned).toEqual([]);
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });

  // cm:guard the case forge-02 raised on 2026-09-13 with four hand-earned statuses live on sid-desk: an issue the dead run had ALREADY advanced keeps what it reached. Returning it would walk it back over a pushed branch and a landed verdict, and the next master would redo the work on top of a branch that is already there.
  it.each(['developed', 'tested', 'awaiting_release', 'closed'])(
    'leaves an issue the run had already carried to %s where it stands',
    async (reached) => {
      execute.mockResolvedValue(runRow(['ISS-241'], { 'ISS-241': 'open' }));
      issueRows([{ seq: 241, status: reached }]);

      expect(await returnIssuesForRun(RUN, { reason: 'box silent' })).toEqual([]);
      expect(transitionIssueStatus).not.toHaveBeenCalled();
    },
  );

  // cm:guard this is what keeps the park rule a RULE rather than dead code: the allowlist runs first and no park is in flight, so the park check can only start mattering again if someone adds a park to the allowlist — which is exactly what this fails on.
  it('never lists a human park as a status to take an issue back from', () => {
    expect(RETURNABLE_FROM.filter((s) => HUMAN_PARK_STATUSES.includes(s))).toEqual([]);
  });

  // cm:guard the sid-desk shape measured 2026-09-13: that project merges to staging BEFORE the issue leaves `testing`, so seven dead runs sat at `testing` with the merge already stamped. Returning them would have sent two to `draft` — outside the pool, where no master is ever handed the issue again — over code already on master.
  it('leaves an issue whose run stamped a merge before dying', async () => {
    execute.mockResolvedValue(runRow(['ISS-265'], { 'ISS-265': 'open' }));
    issueRows([
      {
        seq: 265,
        status: 'testing',
        mergedAt: new Date(RUN_STARTED.getTime() + 60_000),
      },
    ]);

    expect(await returnIssuesForRun(RUN, { reason: 'box silent' })).toEqual([]);
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });

  // cm:guard the other half, and the reason the test is a COMPARISON rather than a null check: `mergedAt` survives a reopen untouched, so a mark from an earlier cycle must not protect this run's issue — that would strand every reopened issue at `in_progress`, which is the defect the module exists to fix.
  it('returns an issue carrying a merge mark left over from an earlier cycle', async () => {
    execute.mockResolvedValue(runRow(['ISS-500'], { 'ISS-500': 'reopen' }));
    issueRows([
      {
        seq: 500,
        status: 'in_progress',
        mergedAt: new Date(RUN_STARTED.getTime() - 86_400_000),
      },
    ]);

    expect(await returnIssuesForRun(RUN, { reason: 'box silent' })).toEqual([
      { issueKey: 'ISS-500', from: 'in_progress', to: 'reopen' },
    ]);
  });

  it('is a no-op when the issue never left the status it was claimed from', async () => {
    execute.mockResolvedValue(runRow(['ISS-1'], { 'ISS-1': 'open' }));
    issueRows([{ seq: 1, status: 'open' }]);

    expect(await returnIssuesForRun(RUN, { reason: 'r' })).toEqual([]);
    expect(transitionIssueStatus).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  // cm:guard the no-op branch reports the ONE case an operator can act on, and stays quiet for the healthy one. `testing` is backlog-admissible, so a master may open a run over an issue already standing there; the floor is then the stuck rung and no return can move it. Counting is all this module may do — the floor is by construction the status the master claimed from.
  it('counts a run that opened over a rung already asserting work nobody was doing', async () => {
    execute.mockResolvedValue(runRow(['ISS-265'], { 'ISS-265': 'testing' }));
    issueRows([{ seq: 265, status: 'testing' }]);

    expect(await returnIssuesForRun(RUN, { reason: 'r' })).toEqual([]);
    expect(transitionIssueStatus).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      [expect.objectContaining({ issueKey: 'ISS-265', status: 'testing' }), expect.any(String)],
    ]);
  });

  // cm:guard a run opened before `runIssueStatuses` existed carries none, and a guessed `open` walks issues backwards out of statuses no run claimed them from.
  it('leaves an issue whose opening status was never recorded alone', async () => {
    execute.mockResolvedValue(runRow(['ISS-9'], {}));
    issueRows([{ seq: 9, status: 'developed' }]);

    expect(await returnIssuesForRun(RUN, { reason: 'r' })).toEqual([]);
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });

  it('returns the rest of the group when one issue refuses', async () => {
    execute.mockResolvedValue(
      runRow(['ISS-1', 'ISS-2'], { 'ISS-1': 'open', 'ISS-2': 'confirmed' }),
    );
    issueRows([
      { seq: 1, status: 'in_progress' },
      { seq: 2, status: 'in_progress' },
    ]);
    transitionIssueStatus.mockRejectedValueOnce(new Error('boom'));

    const returned = await returnIssuesForRun(RUN, { reason: 'r' });

    expect(returned).toEqual([{ issueKey: 'ISS-2', from: 'in_progress', to: 'confirmed' }]);
  });

  it('does nothing for a run that holds no issues', async () => {
    execute.mockResolvedValue(runRow([], {}));
    expect(await returnIssuesForRun(RUN, { reason: 'r' })).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
