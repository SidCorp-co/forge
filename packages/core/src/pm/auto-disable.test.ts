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

function setupTxUpdateChain(): { setSpy: ReturnType<typeof vi.fn>; whereSpy: ReturnType<typeof vi.fn> } {
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
      failureKind: 'infra',
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
      failureKind: 'infra',
      failureReason: null,
    });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('disables config and inserts a notification on the 3rd failure', async () => {
    queueCount([{ count: 3 }]);
    const { setSpy, whereSpy } = setupTxUpdateChain();
    queueTxOwner([{ createdBy: 'owner-1' }]);
    const { valuesSpy } = setupTxInsertChain();

    await handlePmJobFailedAutoDisable({
      jobId: 'j-1',
      projectId: 'p-1',
      issueId: null,
      type: 'pm',
      failureKind: 'infra',
      failureReason: null,
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, cadenceCron: null }),
    );
    expect(whereSpy).toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        projectId: 'p-1',
        type: 'pm_escalation',
      }),
    );
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
      failureKind: 'infra',
      failureReason: null,
    });

    expect(valuesSpy).not.toHaveBeenCalled();
  });
});
