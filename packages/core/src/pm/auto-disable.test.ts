import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const updateMock = vi.fn();
const insertMock = vi.fn();
const txSelectMock = vi.fn();
const txUpdateMock = vi.fn();
const txInsertMock = vi.fn();
const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
  await fn({
    select: txSelectMock,
    update: txUpdateMock,
    insert: txInsertMock,
  });
});

vi.mock('../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    transaction: (fn: (tx: unknown) => Promise<void>) => transactionMock(fn),
  },
}));

const { handlePmJobFailedAutoDisable } = await import('./auto-disable.js');

function queueCount(rows: Array<{ count: number }>): void {
  selectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: async () => rows,
    }),
  }));
}

function queueTxOwner(rows: Array<{ createdBy: string }>): void {
  txSelectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  }));
}

function setupTxUpdateChain(): {
  setSpy: ReturnType<typeof vi.fn>;
  whereSpy: ReturnType<typeof vi.fn>;
} {
  const whereSpy = vi.fn(async () => undefined);
  const setSpy = vi.fn(() => ({ where: whereSpy }));
  txUpdateMock.mockImplementation(() => ({ set: setSpy }));
  return { setSpy, whereSpy };
}

function setupTxInsertChain(): { valuesSpy: ReturnType<typeof vi.fn> } {
  const valuesSpy = vi.fn(async () => undefined);
  txInsertMock.mockImplementation(() => ({ values: valuesSpy }));
  return { valuesSpy };
}

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  insertMock.mockReset();
  txSelectMock.mockReset();
  txUpdateMock.mockReset();
  txInsertMock.mockReset();
  transactionMock.mockClear();
});

describe('handlePmJobFailedAutoDisable', () => {
  it('returns immediately for non-pm payloads', async () => {
    await handlePmJobFailedAutoDisable({
      jobId: 'j-1',
      projectId: 'p-1',
      issueId: null,
      type: 'plan',
      failureKind: 'transient-cc',
      failureReason: null,
    });
    expect(selectMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('does nothing when count is below threshold', async () => {
    queueCount([{ count: 2 }]);
    await handlePmJobFailedAutoDisable({
      jobId: 'j-1',
      projectId: 'p-1',
      issueId: null,
      type: 'pm',
      failureKind: 'transient-cc',
      failureReason: null,
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  // cm:why ISS-1063 — the insert this used to assert is suppressed by the emission
  // switch while the old notification surface is off, so the case now asserts the
  // half that still has to happen (the cadence disable, inside its transaction) and
  // that no row is written. The pairing is the point: the disable must land whether
  // or not anyone is told about it, and a switch that also skipped the disable would
  // be a silence that stopped the product working.
  it('disables config and writes no notification on the 3rd failure while the surface is off', async () => {
    queueCount([{ count: 3 }]);
    const { setSpy, whereSpy } = setupTxUpdateChain();
    queueTxOwner([{ createdBy: 'owner-1' }]);
    const { valuesSpy } = setupTxInsertChain();

    await handlePmJobFailedAutoDisable({
      jobId: 'j-1',
      projectId: 'p-1',
      issueId: null,
      type: 'pm',
      failureKind: 'transient-cc',
      failureReason: null,
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, cadenceCron: null }),
    );
    expect(whereSpy).toHaveBeenCalled();
    expect(valuesSpy).not.toHaveBeenCalled();
  });

  it('skips notification insert when project row is missing (race with delete)', async () => {
    queueCount([{ count: 3 }]);
    setupTxUpdateChain();
    queueTxOwner([]);
    const { valuesSpy } = setupTxInsertChain();

    await handlePmJobFailedAutoDisable({
      jobId: 'j-1',
      projectId: 'p-1',
      issueId: null,
      type: 'pm',
      failureKind: 'transient-cc',
      failureReason: null,
    });

    expect(valuesSpy).not.toHaveBeenCalled();
  });
});
