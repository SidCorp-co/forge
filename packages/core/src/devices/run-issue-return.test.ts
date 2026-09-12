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
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

import { HUMAN_PARK_STATUSES, returnIssuesForRun } from './run-issue-return.js';

const RUN = 'run-1';

/** One run row, as `readRun` reads it back. */
function runRow(keys: string[], statuses: Record<string, string>) {
  return [
    {
      project_id: 'proj-1',
      created_by: 'owner-1',
      keys,
      statuses,
    },
  ];
}

/** The issue rows the drizzle select returns. */
function issueRows(rows: Array<{ seq: number; status: string }>) {
  select.mockReturnValue({
    from: () => ({
      where: async () =>
        rows.map((r) => ({
          id: `issue-${r.seq}`,
          projectId: 'proj-1',
          issSeq: r.seq,
          status: r.status,
          reopenCount: 0,
        })),
    }),
  });
}

beforeEach(() => {
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

  it('is a no-op when the issue never left the status it was claimed from', async () => {
    execute.mockResolvedValue(runRow(['ISS-1'], { 'ISS-1': 'open' }));
    issueRows([{ seq: 1, status: 'open' }]);

    expect(await returnIssuesForRun(RUN, { reason: 'r' })).toEqual([]);
    expect(transitionIssueStatus).not.toHaveBeenCalled();
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
