import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ISS-381 (2.3) — the audited runner-status writer. The key behaviour under test
 * is change-gating: an event row is written only when the status actually
 * changes, so the per-tick device heartbeat (always status='online') does not
 * flood `runner_events`.
 */

const insertValues = vi.fn(async () => {});
const insertFn = vi.fn(() => ({ values: insertValues }));

// Row returned by the FOR UPDATE select inside the transaction.
let selectRows: Array<{ status: string; projectId: string }> = [];

function makeTx() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: async () => selectRows,
          }),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: insertFn,
  };
}

vi.mock('../db/client.js', () => ({
  db: {
    transaction: async (cb: (tx: unknown) => unknown) => cb(makeTx()),
    insert: insertFn,
  },
}));

const { setRunnerStatus, insertRunnerEvent } = await import('./runner-events.js');

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [];
});

describe('setRunnerStatus (change-gated audit)', () => {
  it('writes an event when the status changes', async () => {
    selectRows = [{ status: 'offline', projectId: 'p1' }];
    const res = await setRunnerStatus({ runnerId: 'r1', newStatus: 'online', reason: 'operator_patch' });
    expect(res).toEqual({ found: true, changed: true, oldStatus: 'offline' });
    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerId: 'r1',
        projectId: 'p1',
        oldStatus: 'offline',
        newStatus: 'online',
        reason: 'operator_patch',
      }),
    );
  });

  it('does NOT write an event when the status is unchanged', async () => {
    selectRows = [{ status: 'online', projectId: 'p1' }];
    const res = await setRunnerStatus({ runnerId: 'r1', newStatus: 'online', reason: 'device_heartbeat' });
    expect(res).toEqual({ found: true, changed: false, oldStatus: 'online' });
    expect(insertFn).not.toHaveBeenCalled();
  });

  it('reports not-found for a missing runner without writing an event', async () => {
    selectRows = [];
    const res = await setRunnerStatus({ runnerId: 'gone', newStatus: 'disabled', reason: 'operator_exclude' });
    expect(res).toEqual({ found: false, changed: false, oldStatus: null });
    expect(insertFn).not.toHaveBeenCalled();
  });
});

describe('insertRunnerEvent', () => {
  it('appends one row via the given executor', async () => {
    const { db } = await import('../db/client.js');
    await insertRunnerEvent(db as never, {
      runnerId: 'r1',
      projectId: 'p1',
      oldStatus: null,
      newStatus: 'online',
      reason: 'bind',
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ runnerId: 'r1', oldStatus: null, newStatus: 'online', reason: 'bind' }),
    );
  });
});
