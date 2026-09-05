import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const txUpdateReturning = vi.fn();
const txUpdateWhere = vi.fn(() => ({ returning: txUpdateReturning }));
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
const txUpdate = vi.fn(() => ({ set: txUpdateSet }));

const txSelectLimit = vi.fn();
let existingLabels: { labelId: string }[] = [];
// cm:why the read-back is awaited directly with no `.limit()`; `txSelectLimit` exists only so a reintroduced cap shows up as a call this test can assert on, rather than as a TypeError on a promise
const txSelectWhere = vi.fn(() => {
  const rows = existingLabels;
  return {
    limit: txSelectLimit,
    then: (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r),
  };
});
const txSelectFrom = vi.fn(() => ({ where: txSelectWhere }));
const txSelect = vi.fn(() => ({ from: txSelectFrom }));

const txInsertValues = vi.fn(async () => undefined);
const txInsert = vi.fn(() => ({ values: txInsertValues }));
const txDeleteWhere = vi.fn(async () => undefined);
const txDelete = vi.fn(() => ({ where: txDeleteWhere }));

const tx = {
  update: txUpdate,
  select: txSelect,
  insert: txInsert,
  delete: txDelete,
  execute: vi.fn(async () => undefined),
};

vi.mock('../db/client.js', () => ({
  db: { transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)) },
}));

type ActivityEntry = { action: string; payload: { labelId: string } };
const recordActivityTx = vi.fn(async (_tx: unknown, _entry: ActivityEntry) => undefined);
vi.mock('../pipeline/activity.js', () => ({
  recordActivityTx: (tx: unknown, entry: ActivityEntry) => recordActivityTx(tx, entry),
}));

const { IssueUpdateNotFound, updateIssueFields } = await import('./update-service.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
/** A non-primary attach — this suite is about the activity delta, not the primary module. */
const attach = (labelId: string) => ({ labelId, isPrimary: false });
const ACTOR = {
  type: 'device' as const,
  id: '22222222-2222-4222-8222-222222222222',
  agency: 'agent' as const,
};
const ROW = { id: ISSUE_ID, title: 'x' };

function activityActions(): string[] {
  return recordActivityTx.mock.calls.map(([, entry]) => entry.action);
}

function labeledIds(action: string): string[] {
  return recordActivityTx.mock.calls
    .filter(([, entry]) => entry.action === action)
    .map(([, entry]) => entry.payload.labelId);
}

beforeEach(() => {
  vi.clearAllMocks();
  txUpdateReturning.mockResolvedValue([ROW]);
  existingLabels = [];
});

describe('updateIssueFields', () => {
  it('applies the field updates and returns the updated row', async () => {
    const row = await updateIssueFields({
      issueId: ISSUE_ID,
      updates: { plan: 'the plan' },
      actor: ACTOR,
    });

    expect(txUpdateSet).toHaveBeenCalledWith({ plan: 'the plan' });
    expect(row).toEqual(ROW);
  });

  it('throws IssueUpdateNotFound when the row is gone, so the caller can map its own 404', async () => {
    txUpdateReturning.mockResolvedValue([]);

    await expect(
      updateIssueFields({ issueId: ISSUE_ID, updates: { title: 't' }, actor: ACTOR }),
    ).rejects.toBeInstanceOf(IssueUpdateNotFound);
  });

  it('leaves labels untouched when labelIds is undefined', async () => {
    await updateIssueFields({ issueId: ISSUE_ID, updates: { title: 't' }, actor: ACTOR });

    expect(txDelete).not.toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
    expect(activityActions()).toEqual([]);
  });

  it('clears every label when labelIds is empty, recording one unlabeled per removal', async () => {
    existingLabels = [{ labelId: 'L1' }, { labelId: 'L2' }];

    await updateIssueFields({ issueId: ISSUE_ID, updates: {}, labelIds: [], actor: ACTOR });

    expect(txDelete).toHaveBeenCalled();
    expect(txInsert).not.toHaveBeenCalled();
    expect(labeledIds('issue.unlabeled').sort()).toEqual(['L1', 'L2']);
    expect(labeledIds('issue.labeled')).toEqual([]);
  });

  it('records only the delta — a label present before and after is neither added nor removed', async () => {
    existingLabels = [{ labelId: 'KEEP' }, { labelId: 'GONE' }];

    await updateIssueFields({
      issueId: ISSUE_ID,
      updates: {},
      labelIds: [attach('KEEP'), attach('NEW')],
      actor: ACTOR,
    });

    expect(labeledIds('issue.labeled')).toEqual(['NEW']);
    expect(labeledIds('issue.unlabeled')).toEqual(['GONE']);
  });

  /**
   * The MCP copy this service replaced capped the existing-label read at 500
   * rows. Past that cap the delta was computed against a truncated `oldSet`, so
   * a label the caller kept was reported as newly added and a label it dropped
   * was never reported as removed.
   */
  it('reads the existing label set with no row cap', async () => {
    existingLabels = [{ labelId: 'KEEP' }];

    await updateIssueFields({
      issueId: ISSUE_ID,
      updates: {},
      labelIds: [attach('KEEP')],
      actor: ACTOR,
    });

    expect(
      txSelectLimit,
      'the existing-label read is capped again. Past the cap the delta is computed against a ' +
        'truncated oldSet, so a kept label is reported as newly added and a dropped one is ' +
        'never reported as removed — the drift this service was extracted to end.',
    ).not.toHaveBeenCalled();
    expect(activityActions()).toEqual([]);
  });
});
