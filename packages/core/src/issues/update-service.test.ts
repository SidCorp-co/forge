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

/** The locked row's composed `sessionContext`; `null` holds no row at all (it was deleted). */
let locked: { session_context: unknown } | null = { session_context: null };
const txExecute = vi.fn(async (_query: unknown) => undefined as unknown);

const tx = {
  update: txUpdate,
  select: txSelect,
  insert: txInsert,
  delete: txDelete,
  execute: txExecute,
};

vi.mock('../db/client.js', () => ({
  db: { transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)) },
}));

type ActivityEntry = { action: string; payload: { labelId: string } };
const recordActivityTx = vi.fn(async (_tx: unknown, _entry: ActivityEntry) => undefined);
vi.mock('../requirements/issue-links.js', () => ({ plannedRevisionFor: async () => null }));
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
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ROW = { id: ISSUE_ID, projectId: PROJECT_ID, title: 'x' };

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
  txUpdateReturning.mockResolvedValue([{ id: ISSUE_ID }]);
  // The written row, read back with its composed sessionContext and work state.
  txSelectLimit.mockResolvedValue([ROW]);
  // The row is locked first and its composed `sessionContext` read; none stored by default.
  locked = { session_context: null };
  txExecute.mockImplementation(async () => []);
  txExecute.mockImplementationOnce(async () => (locked ? [locked] : []));
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
    locked = null;

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
        'never reported as removed — the drift this service was extracted to end. (The one ' +
        'limited read is the written row read back.)',
    ).toHaveBeenCalledTimes(1);
    expect(activityActions()).toEqual([]);
  });
});

// The ISS-1127 destruction: `{ probe: 1 }` replaced a sessionContext holding
// `landing`, `lease` and `worklog`, and nothing refused it. The landing
// checkpoint under it had no history to be read back from.
describe('updateIssueFields — a sessionContext write may not drop what it never read', () => {
  const held = { landing: { head: 'a3b04356' }, lease: { holder: 'x' }, worklog: {} };

  beforeEach(() => {
    locked = { session_context: held };
  });

  it('refuses the write, naming every key it would have removed', async () => {
    await expect(
      updateIssueFields({
        issueId: ISSUE_ID,
        updates: { sessionContext: { probe: 1 } },
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({
      name: 'SessionContextDropsUnreadKeys',
      dropped: ['landing', 'lease', 'worklog'],
    });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('allows a write that adds a key and carries the rest back', async () => {
    const next = { ...held, landing: { head: 'a3b04356', deployment: 'ae8cdcbb0' } };
    await expect(
      updateIssueFields({ issueId: ISSUE_ID, updates: { sessionContext: next }, actor: ACTOR }),
    ).resolves.toMatchObject({ id: ISSUE_ID });
  });

  it('allows a deliberate removal, because `expect` proves the caller read the field', async () => {
    await expect(
      updateIssueFields({
        issueId: ISSUE_ID,
        updates: { sessionContext: { probe: 1 } },
        expect: { sessionContext: held },
        actor: ACTOR,
      }),
    ).resolves.toMatchObject({ id: ISSUE_ID });
  });
});

// ISS-54 cm:hack — the lease lives on `issue_work_state`; a whole `sessionContext` write is split.
describe('updateIssueFields — the lease and the worklog leave the blob', () => {
  it('writes the blob without its lease, and hands the lease to the work state', async () => {
    const lease = { holder: 'run-1', renewedAt: '2026-10-03T00:00:00Z', minutes: 30 };
    await updateIssueFields({
      issueId: ISSUE_ID,
      updates: { sessionContext: { lease, note: 'kept' } },
      expect: { sessionContext: null },
      actor: ACTOR,
    });
    expect(txUpdateSet).toHaveBeenCalledWith({ sessionContext: { note: 'kept' } });
    // The lock, then the work-state upsert carrying the lease.
    expect(txExecute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(txExecute.mock.calls[1]?.[0])).toContain('issue_work_state');
  });

  it('refuses a stale `expect` with the composed value it moved to, writing nothing', async () => {
    const current = { lease: { holder: 'run-a' } };
    locked = { session_context: current };
    await expect(
      updateIssueFields({
        issueId: ISSUE_ID,
        updates: { sessionContext: { lease: { holder: 'run-b' } } },
        expect: { sessionContext: null },
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({ name: 'SessionContextExpectMismatch', current });
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it('compares `expect` as JSON does: key order is not part of the value', async () => {
    locked = { session_context: { a: 1, b: { c: 2, d: 3 } } };
    await expect(
      updateIssueFields({
        issueId: ISSUE_ID,
        updates: { sessionContext: {} },
        expect: { sessionContext: { b: { d: 3, c: 2 }, a: 1 } },
        actor: ACTOR,
      }),
    ).resolves.toMatchObject({ id: ISSUE_ID });
  });
});
