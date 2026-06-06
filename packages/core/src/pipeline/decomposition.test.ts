import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbSelect = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

function selectJoinChainOnce(rows: unknown[]): void {
  dbSelect.mockImplementationOnce(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({ limit: async () => rows, then: (cb: (v: unknown) => unknown) => Promise.resolve(rows).then(cb) }),
      }),
    }),
  }));
}

const {
  DECOMP_CHILD_READY_STATUSES,
  DECOMP_PARENT_RELEASED_STATUSES,
  allChildrenReady,
  findDecompositionChildren,
  findDecompositionParent,
} = await import('./decomposition.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DECOMP_CHILD_READY_STATUSES', () => {
  it('contains staging, released, closed', () => {
    expect(DECOMP_CHILD_READY_STATUSES.has('staging')).toBe(true);
    expect(DECOMP_CHILD_READY_STATUSES.has('released')).toBe(true);
    expect(DECOMP_CHILD_READY_STATUSES.has('closed')).toBe(true);
  });

  it('excludes earlier-stage statuses', () => {
    expect(DECOMP_CHILD_READY_STATUSES.has('in_progress')).toBe(false);
    expect(DECOMP_CHILD_READY_STATUSES.has('developed')).toBe(false);
    expect(DECOMP_CHILD_READY_STATUSES.has('approved')).toBe(false);
  });
});

describe('DECOMP_PARENT_RELEASED_STATUSES', () => {
  it('contains released and closed (treated equivalent for gate)', () => {
    expect(DECOMP_PARENT_RELEASED_STATUSES.has('released')).toBe(true);
    expect(DECOMP_PARENT_RELEASED_STATUSES.has('closed')).toBe(true);
  });

  it('excludes staging — parent integration test must pass before children release', () => {
    expect(DECOMP_PARENT_RELEASED_STATUSES.has('staging')).toBe(false);
  });
});

describe('allChildrenReady', () => {
  it('returns false for empty input (parent with no decomposition edges)', () => {
    expect(allChildrenReady([])).toBe(false);
  });

  it('returns true when all are staging', () => {
    expect(
      allChildrenReady([{ status: 'staging' }, { status: 'staging' }, { status: 'staging' }]),
    ).toBe(true);
  });

  it('returns true when statuses are a mix of staging/released/closed', () => {
    expect(
      allChildrenReady([{ status: 'staging' }, { status: 'released' }, { status: 'closed' }]),
    ).toBe(true);
  });

  it('returns false when any sibling is mid-pipeline', () => {
    expect(
      allChildrenReady([
        { status: 'staging' },
        { status: 'staging' },
        { status: 'in_progress' },
      ]),
    ).toBe(false);
  });

  it('returns false when any sibling is approved (early stage)', () => {
    expect(allChildrenReady([{ status: 'staging' }, { status: 'approved' }])).toBe(false);
  });
});

describe('findDecompositionChildren', () => {
  it('returns the joined rows as children with status + projectId', async () => {
    selectJoinChainOnce([
      { id: 'c-1', status: 'draft', projectId: 'p-1' },
      { id: 'c-2', status: 'open', projectId: 'p-1' },
    ]);
    const children = await findDecompositionChildren('parent-1');
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ id: 'c-1', status: 'draft', projectId: 'p-1' });
    expect(children[1]).toMatchObject({ id: 'c-2', status: 'open', projectId: 'p-1' });
  });

  it('returns [] when there are no decomposition edges', async () => {
    selectJoinChainOnce([]);
    expect(await findDecompositionChildren('parent-without-children')).toEqual([]);
  });
});

describe('findDecompositionParent', () => {
  it('returns the first parent row including issSeq for messaging', async () => {
    selectJoinChainOnce([
      { id: 'parent-1', status: 'approved', projectId: 'p-1', issSeq: 42 },
    ]);
    const parent = await findDecompositionParent('child-1');
    expect(parent).toMatchObject({ id: 'parent-1', status: 'approved', issSeq: 42 });
  });

  it('returns null when the child has no inbound decomposes edge', async () => {
    selectJoinChainOnce([]);
    expect(await findDecompositionParent('orphan-1')).toBeNull();
  });
});
