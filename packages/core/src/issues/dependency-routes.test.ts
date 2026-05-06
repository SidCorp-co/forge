/**
 * ISS-40 PR-E — dependency-routes cycle detection unit tests. The route
 * handlers themselves are integration-tested at the platform level; here
 * we focus on `detectCycle` since it's the load-bearing safety check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbSelect = vi.fn();

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn(async () => {}) },
}));

const { detectCycle } = await import('./dependency-routes.js');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Build a chain-of-mocks that responds to the per-call db.select queries
 * in dfs order. The `start` parameter controls which node we traverse from.
 */
function withGraph(graph: Record<string, string[]>): void {
  dbSelect.mockImplementation(() => {
    let capturedNode: string | null = null;
    return {
      from: () => ({
        where: (clauseFn: unknown) => {
          // Drizzle builds an AST; we can't read it cleanly here, so the
          // test seeds a single fact-table per from→children call by
          // returning the next chain in a queue. To keep this test simple
          // we use the *sequence* of calls and pop from a flattened plan.
          void clauseFn;
          return { /* unreachable */ };
        },
      }),
    };
  });
  // Override with a queue-driven implementation: each call pulls from the
  // pre-built children array. The DFS calls db.select once per node we
  // expand; we pre-seed those calls in the order DFS will visit.
  const visitOrder: string[] = [];
  const visit = (node: string, seen: Set<string>): void => {
    if (seen.has(node)) return;
    seen.add(node);
    visitOrder.push(node);
    for (const child of graph[node] ?? []) visit(child, seen);
  };
  // We don't pre-walk; instead, the implementation reads `from` and `where`
  // chain-of-mocks reactively. Each call to dbSelect represents a "give me
  // children of node X" — but Drizzle's where() is opaque without
  // introspection. Simplification: respond with a flat queue keyed by call
  // count, where the test author has set graph traversal in DFS order.
  void visit;
  void visitOrder;
}

describe('detectCycle', () => {
  it('returns "cycle" for a self-edge target', async () => {
    expect(await detectCycle('A', 'A')).toBe('cycle');
  });

  it('returns null when the graph is empty', async () => {
    // every db.select returns no children
    dbSelect.mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    expect(await detectCycle('B', 'A')).toBeNull();
  });

  it('returns "cycle" when DFS reaches the target', async () => {
    // graph: B -> A. Calling detectCycle('B','A') walks from B and
    // immediately finds A as a child.
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([{ to: 'A' }]) }),
    }));
    expect(await detectCycle('B', 'A')).toBe('cycle');
  });

  it('returns null when DFS exhausts without reaching target', async () => {
    // B -> C, C -> D (no edge to A)
    dbSelect
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([{ to: 'C' }]) }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([{ to: 'D' }]) }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([]) }),
      }));
    expect(await detectCycle('B', 'A')).toBeNull();
  });
});
