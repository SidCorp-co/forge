import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertValues = vi.fn();
const dbInsert = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: { insert: dbInsert },
}));

const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { error: loggerError },
}));

const { recordActivity, recordActivityTx, safeRecordActivity, resolveActor } = await import(
  './activity.js'
);
const { activityLog } = await import('../db/schema.js');

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  insertValues.mockReset();
  insertValues.mockResolvedValue(undefined);
  dbInsert.mockClear();
  dbInsert.mockImplementation(() => ({ values: insertValues }));
  loggerError.mockReset();
});

describe('recordActivity', () => {
  it('inserts row with merged payload (before/after/extra)', async () => {
    await recordActivity({
      issueId: ISSUE_ID,
      actor: { type: 'user', id: USER_ID },
      action: 'issue.updated',
      before: { title: 'old' },
      after: { title: 'new' },
      payload: { fields: ['title'] },
    });

    expect(dbInsert).toHaveBeenCalledWith(activityLog);
    expect(insertValues).toHaveBeenCalledWith({
      issueId: ISSUE_ID,
      actorType: 'user',
      actorId: USER_ID,
      action: 'issue.updated',
      payload: { before: { title: 'old' }, after: { title: 'new' }, fields: ['title'] },
    });
  });

  it('uses empty payload object when none supplied', async () => {
    await recordActivity({
      issueId: ISSUE_ID,
      actor: { type: 'device', id: DEVICE_ID },
      action: 'issue.created',
    });

    expect(insertValues).toHaveBeenCalledWith({
      issueId: ISSUE_ID,
      actorType: 'device',
      actorId: DEVICE_ID,
      action: 'issue.created',
      payload: {},
    });
  });
});

describe('recordActivityTx', () => {
  it('uses the passed tx handle', async () => {
    const txValues = vi.fn().mockResolvedValue(undefined);
    const txInsert = vi.fn(() => ({ values: txValues }));
    const tx = { insert: txInsert } as unknown as Parameters<typeof recordActivityTx>[0];

    await recordActivityTx(tx, {
      issueId: ISSUE_ID,
      actor: { type: 'user', id: USER_ID },
      action: 'issue.labeled',
      payload: { labelId: 'x' },
    });

    expect(txInsert).toHaveBeenCalledWith(activityLog);
    expect(txValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue.labeled', payload: { labelId: 'x' } }),
    );
    expect(dbInsert).not.toHaveBeenCalled();
  });
});

describe('safeRecordActivity', () => {
  it('swallows db errors and logs', async () => {
    const err = new Error('db down');
    insertValues.mockRejectedValueOnce(err);

    await expect(
      safeRecordActivity({
        issueId: ISSUE_ID,
        actor: { type: 'user', id: USER_ID },
        action: 'issue.created',
      }),
    ).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err, action: 'issue.created', issueId: ISSUE_ID }),
      'activity_log insert failed',
    );
  });

  it('returns without logging on success', async () => {
    await safeRecordActivity({
      issueId: ISSUE_ID,
      actor: { type: 'user', id: USER_ID },
      action: 'issue.created',
    });
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe('resolveActor', () => {
  function ctx(vars: Record<string, unknown>): Context {
    return { get: (k: string) => vars[k] } as unknown as Context;
  }

  it('returns user principal when userId is set', () => {
    expect(resolveActor(ctx({ userId: USER_ID }))).toEqual({ type: 'user', id: USER_ID });
  });

  it('returns device principal when only device is set', () => {
    expect(resolveActor(ctx({ device: { id: DEVICE_ID } }))).toEqual({
      type: 'device',
      id: DEVICE_ID,
    });
  });

  it('prefers user when both are set', () => {
    expect(resolveActor(ctx({ userId: USER_ID, device: { id: DEVICE_ID } }))).toEqual({
      type: 'user',
      id: USER_ID,
    });
  });

  it('throws when neither principal is present', () => {
    expect(() => resolveActor(ctx({}))).toThrow(/no user or device principal/);
  });
});
