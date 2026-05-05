import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeMock = vi.fn();
const deleteWhereMock = vi.fn();
const deleteMock = vi.fn(() => ({ where: deleteWhereMock }));
// Memory-prune now wraps each batch in `db.transaction`. The mock invokes
// the callback synchronously with a tx that proxies to the same execute/
// delete spies the existing tests assert against.
const transactionMock = vi.fn(
  async (cb: (tx: { execute: typeof executeMock; delete: typeof deleteMock }) => unknown) =>
    cb({ execute: executeMock, delete: deleteMock }),
);

vi.mock('../db/client.js', () => ({
  db: { execute: executeMock, delete: deleteMock, transaction: transactionMock },
}));

const warnMock = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: warnMock, error: vi.fn() },
}));

const { runMemoryPrune } = await import('./prune.js');

beforeEach(() => {
  executeMock.mockReset();
  deleteWhereMock.mockReset();
  deleteMock.mockClear();
  transactionMock.mockClear();
  warnMock.mockClear();
});

describe('memory/prune — runMemoryPrune', () => {
  it('returns prunedMemories=0 + cascadedEdges=0 when nothing matches', async () => {
    // 3 calls: stale-memories DELETE-CTE, rare-memories DELETE-CTE, edges UPDATE.
    // Both memory deletes return empty → no edge cascade. Final UPDATE returns 0.
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce({ count: 0 });

    const result = await runMemoryPrune();
    expect(result.prunedMemories).toBe(0);
    expect(result.cascadedEdges).toBe(0);
    expect(result.invalidatedEdges).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(typeof result.durationMs).toBe('number');
  });

  it('cascades knowledge_edges deletions for each pruned-memory batch', async () => {
    // Stale predicate: returns 2 ids → cascade with 5 edges deleted.
    executeMock.mockResolvedValueOnce([{ id: 'mem-a' }, { id: 'mem-b' }]);
    deleteWhereMock.mockResolvedValueOnce({ count: 5 });
    // Rare predicate: returns 1 id → cascade with 2 edges.
    executeMock.mockResolvedValueOnce([{ id: 'mem-c' }]);
    deleteWhereMock.mockResolvedValueOnce({ count: 2 });
    // Final invalidate.
    executeMock.mockResolvedValueOnce({ count: 4 });

    const result = await runMemoryPrune();
    expect(result.prunedMemories).toBe(3);
    expect(result.cascadedEdges).toBe(7);
    expect(result.invalidatedEdges).toBe(4);
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it('iterates the stale predicate in batches until a short batch signals completion', async () => {
    // First stale batch: 10_000 ids → cascade. Second: 3 ids → cascade → exit.
    const big = Array.from({ length: 10_000 }, (_, i) => ({ id: `m${i}` }));
    executeMock.mockResolvedValueOnce(big);
    deleteWhereMock.mockResolvedValueOnce({ count: 0 });
    executeMock.mockResolvedValueOnce([{ id: 'x' }, { id: 'y' }, { id: 'z' }]);
    deleteWhereMock.mockResolvedValueOnce({ count: 0 });
    // Rare predicate returns nothing.
    executeMock.mockResolvedValueOnce([]);
    // Final invalidate.
    executeMock.mockResolvedValueOnce({ count: 1 });

    const result = await runMemoryPrune();
    expect(result.prunedMemories).toBe(10_003);
    expect(result.invalidatedEdges).toBe(1);
  });

  it('skips edge cascade when a batch returns no ids (rowCount path)', async () => {
    // Driver without RETURNING — rowCount-only result, no ids.
    executeMock.mockResolvedValueOnce({ rowCount: 0 });
    executeMock.mockResolvedValueOnce({ rowCount: 0 });
    executeMock.mockResolvedValueOnce({ rowCount: 0 });

    const result = await runMemoryPrune();
    expect(result.prunedMemories).toBe(0);
    expect(result.cascadedEdges).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('warns when a driver reports rowCount>0 but no RETURNING ids (cascade would be skipped)', async () => {
    // Hypothetical future driver path: counts deletes via rowCount but does
    // not surface RETURNING rows. Without the warning, the edge cascade
    // would silently no-op and leave orphan knowledge_edges rows.
    executeMock.mockResolvedValueOnce({ rowCount: 7 });
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce({ count: 0 });

    const result = await runMemoryPrune();
    expect(result.prunedMemories).toBe(7);
    expect(result.cascadedEdges).toBe(0);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ rowCount: 7 }),
      expect.stringContaining('edge cascade skipped'),
    );
  });

  it('iterates the edge invalidation in batches until a short batch signals completion', async () => {
    // Memory deletes both empty.
    executeMock.mockResolvedValueOnce([]);
    executeMock.mockResolvedValueOnce([]);
    // Edge invalidation: full batch then short batch.
    executeMock.mockResolvedValueOnce({ count: 10_000 });
    executeMock.mockResolvedValueOnce({ count: 42 });

    const result = await runMemoryPrune();
    expect(result.invalidatedEdges).toBe(10_042);
    // 2 memory-DELETE CTEs + 2 edge-UPDATE CTEs.
    expect(executeMock).toHaveBeenCalledTimes(4);
  });
});
