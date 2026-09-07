/**
 * ISS-40 PR-E — cycle detection, the load-bearing safety check on the shared
 * edge write. ISS-889 moved it out of `dependency-routes.ts` into
 * `cycle-detect.ts` when REST and MCP collapsed onto one write path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbSelect = vi.fn();

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

vi.mock('../pipeline/hooks.js', () => ({ hooks: { emit: vi.fn(async () => {}) } }));

vi.mock('./decompose.js', () => ({ decomposeParent: vi.fn(async () => {}) }));
vi.mock('./pipeline-health.js', () => ({
  publishPipelineHealthChanged: vi.fn(async () => {}),
  hydratePipelineHealthForIssues: vi.fn(async () => new Map()),
}));
vi.mock('../pipeline/activity.js', () => ({
  safeRecordActivity: vi.fn(async () => {}),
  recordActivityTx: vi.fn(async () => {}),
}));

const { detectCycle } = await import('./cycle-detect.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('detectCycle', () => {
  it('returns "cycle" for a self-edge target', async () => {
    expect(await detectCycle('A', 'A')).toBe('cycle');
  });

  it('returns null when the graph is empty', async () => {
    dbSelect.mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    expect(await detectCycle('B', 'A')).toBeNull();
  });

  it('returns "cycle" when DFS reaches the target', async () => {
    dbSelect.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([{ to: 'A' }]) }),
    }));
    expect(await detectCycle('B', 'A')).toBe('cycle');
  });

  // cm:guard an expired edge is a RETRACTED one and the row stays as the record that it once held, so counting it refuses a new edge on the strength of one the dispatcher already ignores — plant handling that reads every row regardless of `validUntil` and this pair is what goes red, the second case holding the boundary so "ignore every expiry" cannot pass for the fix.
  it('does not follow an edge whose validUntil has passed', async () => {
    dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve([{ to: 'A', validUntil: '2020-01-01T00:00:00Z' }]),
      }),
    }));
    expect(await detectCycle('B', 'A')).toBeNull();
  });

  it('follows an edge whose validUntil is still in the future', async () => {
    dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve([{ to: 'A', validUntil: '2099-01-01T00:00:00Z' }]),
      }),
    }));
    expect(await detectCycle('B', 'A')).toBe('cycle');
  });

  it('returns null when DFS exhausts without reaching target', async () => {
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
