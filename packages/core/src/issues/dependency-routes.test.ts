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
