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

const { hooks } = await import('../pipeline/hooks.js');
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
  txUpdateReturning.mockResolvedValue([ROW]);
  // No stored `sessionContext` by default: the drop guard reads the row before
  // every write that carries the field, and has nothing to protect here.
  txSelectLimit.mockResolvedValue([]);
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

/** Every `contractInputChanged` this suite heard, on the one bus the writer emits to. */
const heard: { projectId: string; issueId?: string; reason: string }[] = [];
hooks.on(
  'contractInputChanged',
  async (payload) => {
    heard.push(payload);
  },
  { name: 'update-service-test-listener' },
);

/**
 * ISS-1072 — the announcement a published contract check is re-read on.
 *
 * It is emitted HERE rather than off `issueUpdated` because this is where both
 * field surfaces converge: `issues/patch-fields.ts` records that REST emits
 * `issueUpdated` and MCP's update deliberately does not, and MCP's update is the
 * door `forge record plan` and `forge record criteria` come through. A
 * subscriber on `issueUpdated` would miss exactly the writes a contract check is
 * most about.
 */
describe('contractInputChanged', () => {
  beforeEach(() => {
    heard.length = 0;
  });

  it.each([
    ['plan', { plan: 'the plan' }],
    ['acceptanceCriteria', { acceptanceCriteria: '1. it works' }],
    ['releaseNotes', { releaseNotes: { section: 'Skip', userFacing: '-' } }],
    ['sessionContext', { sessionContext: { lease: {} } }],
  ])('announces a write of `%s`, naming the issue and its project', async (field, updates) => {
    await updateIssueFields({ issueId: ISSUE_ID, updates: updates as never, actor: ACTOR });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ projectId: PROJECT_ID, issueId: ISSUE_ID });
    expect(heard[0]?.reason).toContain(field);
  });

  it('announces `mergedAt` written through this door as well', async () => {
    await updateIssueFields({
      issueId: ISSUE_ID,
      updates: { mergedAt: new Date() } as never,
      actor: ACTOR,
    });
    expect(heard).toHaveLength(1);
  });

  it('stays silent for a field no declared criterion reads', async () => {
    await updateIssueFields({ issueId: ISSUE_ID, updates: { title: 't' }, actor: ACTOR });
    expect(heard).toEqual([]);
  });

  it('announces nothing when the write itself failed', async () => {
    txUpdateReturning.mockResolvedValue([]);
    await expect(
      updateIssueFields({ issueId: ISSUE_ID, updates: { plan: 'p' }, actor: ACTOR }),
    ).rejects.toBeInstanceOf(IssueUpdateNotFound);
    expect(heard).toEqual([]);
  });
});

// The ISS-1127 destruction: `{ probe: 1 }` replaced a sessionContext holding
// `landing`, `lease` and `worklog`, and nothing refused it. The landing
// checkpoint under it had no history to be read back from.
describe('updateIssueFields — a sessionContext write may not drop what it never read', () => {
  const held = { landing: { head: 'a3b04356' }, lease: { holder: 'x' }, worklog: {} };

  beforeEach(() => {
    txSelectLimit.mockResolvedValue([{ sessionContext: held }]);
    txUpdateReturning.mockResolvedValue([ROW]);
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
