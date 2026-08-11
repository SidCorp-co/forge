import { describe, expect, it, vi } from 'vitest';
import { type IssueStatus, issueStatuses } from '../db/schema.js';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('../pipeline/outbox-session.js', () => ({ withActorContext: vi.fn() }));
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: vi.fn(),
  setCurrentStepForOpenIssueRun: vi.fn(),
}));

const { bucketOf, buildProgressFactsBlock, computeProjectProgress } = await import('./progress.js');

function makeChain(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const chain = {
    from: () => chain,
    where: () => chain,
    groupBy: () => Promise.resolve(rows),
  };
  return chain;
}

/** `computeProjectProgress` makes two `db.select` calls in order: the
 *  project's `agentConfig` (to resolve `mergeStates.baseBranch`), then the
 *  grouped issue rows. */
function fakeDb(
  rows: Array<Record<string, unknown>>,
  agentConfig: unknown = null,
): { select: () => unknown } {
  let call = 0;
  return {
    select: () => {
      call += 1;
      if (call === 1) {
        return {
          from: () => ({ where: () => ({ limit: () => Promise.resolve([{ agentConfig }]) }) }),
        };
      }
      return makeChain(rows);
    },
  };
}

function failingDb(): { select: () => unknown } {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.reject(new Error('connection reset')),
        }),
      }),
    }),
  };
}

const REMAINING: IssueStatus[] = ['draft', 'waiting', 'needs_info', 'on_hold'];

describe('bucketOf', () => {
  it('released always counts as shipped, regardless of everLeftBaseMergeState', () => {
    expect(bucketOf('released', false)).toBe('shipped');
    expect(bucketOf('released', true)).toBe('shipped');
  });

  it('closed WITH evidence of leaving the base merge state counts as shipped', () => {
    expect(bucketOf('closed', true)).toBe('shipped');
  });

  it('closed WITHOUT ever leaving the base merge state is closed_unshipped, not shipped', () => {
    expect(bucketOf('closed', false)).toBe('closed_unshipped');
  });

  it('covers all 15 statuses x everLeftBaseMergeState true/false with a single bucket each', () => {
    for (const status of issueStatuses) {
      for (const everLeftBaseMergeState of [true, false]) {
        const bucket = bucketOf(status, everLeftBaseMergeState);
        expect(['shipped', 'closed_unshipped', 'in_flight', 'remaining']).toContain(bucket);
      }
    }
  });

  it('remaining statuses land in remaining regardless of everLeftBaseMergeState', () => {
    for (const status of REMAINING) {
      expect(bucketOf(status, false)).toBe('remaining');
      expect(bucketOf(status, true)).toBe('remaining');
    }
  });

  it('everything else (non-closed, non-released) lands in in_flight', () => {
    const inFlightStatuses = issueStatuses.filter(
      (s) => !REMAINING.includes(s) && s !== 'closed' && s !== 'released',
    );
    for (const status of inFlightStatuses) {
      expect(bucketOf(status, false)).toBe('in_flight');
      expect(bucketOf(status, true)).toBe('in_flight');
    }
  });
});

describe('computeProjectProgress', () => {
  it('shipped + closedUnshipped + inFlight + remaining === total', async () => {
    const db = fakeDb([
      { status: 'closed', everLeftBaseMergeState: true, count: 21 },
      { status: 'closed', everLeftBaseMergeState: false, count: 33 },
      { status: 'open', everLeftBaseMergeState: false, count: 7 },
      { status: 'draft', everLeftBaseMergeState: false, count: 3 },
    ]);
    const progress = await computeProjectProgress('p1', db as never);
    if (!progress) throw new Error('expected a progress snapshot');
    expect(progress.shipped).toBe(21);
    expect(progress.closedUnshipped).toBe(33);
    expect(progress.inFlight).toBe(7);
    expect(progress.remaining).toBe(3);
    expect(progress.total).toBe(
      progress.shipped + progress.closedUnshipped + progress.inFlight + progress.remaining,
    );
    expect(progress.total).toBe(64);
  });

  it('does not conflate closed-without-shipping into shipped (the 39%-overstatement bug)', async () => {
    const db = fakeDb([
      { status: 'closed', everLeftBaseMergeState: true, count: 52 },
      { status: 'closed', everLeftBaseMergeState: false, count: 33 },
    ]);
    const progress = await computeProjectProgress('p1', db as never);
    if (!progress) throw new Error('expected a progress snapshot');
    expect(progress.shipped).toBe(52);
    expect(progress.closedUnshipped).toBe(33);
    expect(progress.total).toBe(85);
  });

  it('two consecutive computes on unchanged data return identical numbers', async () => {
    const rows = [
      { status: 'closed', everLeftBaseMergeState: true, count: 54 },
      { status: 'open', everLeftBaseMergeState: false, count: 7 },
      { status: 'draft', everLeftBaseMergeState: false, count: 3 },
    ];
    const a = await computeProjectProgress('p1', fakeDb(rows) as never);
    const b = await computeProjectProgress('p1', fakeDb(rows) as never);
    expect(a?.shipped).toBe(b?.shipped);
    expect(a?.closedUnshipped).toBe(b?.closedUnshipped);
    expect(a?.inFlight).toBe(b?.inFlight);
    expect(a?.remaining).toBe(b?.remaining);
    expect(a?.total).toBe(b?.total);
  });

  it('an empty project returns all zeros, not null', async () => {
    const progress = await computeProjectProgress('empty', fakeDb([]) as never);
    expect(progress).toEqual(
      expect.objectContaining({
        shipped: 0,
        closedUnshipped: 0,
        inFlight: 0,
        remaining: 0,
        total: 0,
      }),
    );
  });

  it('released counts as shipped alongside a genuinely-shipped closed issue', async () => {
    const db = fakeDb([
      { status: 'closed', everLeftBaseMergeState: true, count: 2 },
      { status: 'released', everLeftBaseMergeState: true, count: 5 },
    ]);
    const progress = await computeProjectProgress('p1', db as never);
    expect(progress?.shipped).toBe(7);
  });

  it('resolves the base-merge state from the project agentConfig, defaulting to released', async () => {
    const db = fakeDb([{ status: 'closed', everLeftBaseMergeState: true, count: 1 }], {
      pipelineConfig: { mergeStates: { baseBranch: 'tested' } },
    });
    const progress = await computeProjectProgress('p1', db as never);
    expect(progress?.shipped).toBe(1);
  });

  it('returns null (fail-closed) on a DB error', async () => {
    const progress = await computeProjectProgress('p1', failingDb() as never);
    expect(progress).toBeNull();
  });
});

describe('buildProgressFactsBlock', () => {
  it('renders each figure with its own definition', () => {
    const block = buildProgressFactsBlock({
      shipped: 52,
      closedUnshipped: 33,
      inFlight: 7,
      remaining: 3,
      total: 95,
      byStatus: {} as never,
      computedAt: new Date(),
    });
    expect(block).toContain('shipped');
    expect(block).toContain('52');
    expect(block).toMatch(/closed without shipping.*33/s);
    expect(block).toContain('in progress: 7');
    expect(block).toContain('not started: 3');
    expect(block).toContain('total: 95');
    expect(block).toMatch(/AUTHORITATIVE/);
  });
});
