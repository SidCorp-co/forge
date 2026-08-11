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

function fakeDb(rows: Array<Record<string, unknown>>): { select: () => unknown } {
  return { select: () => makeChain(rows) };
}

function failingDb(): { select: () => unknown } {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          groupBy: () => Promise.reject(new Error('connection reset')),
        }),
      }),
    }),
  };
}

const NEVER_DONE_VIA_MERGED_AT: IssueStatus[] = ['draft', 'on_hold', 'needs_info', 'reopen'];
const REMAINING: IssueStatus[] = ['draft', 'waiting', 'needs_info', 'on_hold'];

describe('bucketOf', () => {
  it('closed and released always count as done, mergedAt or not', () => {
    for (const status of ['closed', 'released'] as const) {
      expect(bucketOf(status, null)).toBe('done');
      expect(bucketOf(status, new Date())).toBe('done');
    }
  });

  it('a mergedAt on an otherwise in-flight status counts as done', () => {
    expect(bucketOf('testing', new Date())).toBe('done');
    expect(bucketOf('tested', new Date())).toBe('done');
  });

  it('a stale mergedAt on draft/on_hold/needs_info/reopen does NOT count as done', () => {
    for (const status of NEVER_DONE_VIA_MERGED_AT) {
      expect(bucketOf(status, new Date())).not.toBe('done');
    }
  });

  it('covers all 15 statuses x mergedAt null/set with a single bucket each', () => {
    for (const status of issueStatuses) {
      for (const mergedAt of [null, new Date()]) {
        const bucket = bucketOf(status, mergedAt);
        expect(['done', 'in_flight', 'remaining']).toContain(bucket);
      }
    }
  });

  it('remaining statuses without a merge land in remaining', () => {
    for (const status of REMAINING) {
      expect(bucketOf(status, null)).toBe('remaining');
    }
  });

  it('everything else without a merge lands in in_flight', () => {
    const inFlightStatuses = issueStatuses.filter(
      (s) => !REMAINING.includes(s) && s !== 'closed' && s !== 'released',
    );
    for (const status of inFlightStatuses) {
      expect(bucketOf(status, null)).toBe('in_flight');
    }
  });
});

describe('computeProjectProgress', () => {
  it('done + inFlight + remaining === total', async () => {
    const db = fakeDb([
      { status: 'closed', merged: true, count: 54 },
      { status: 'open', merged: false, count: 7 },
      { status: 'draft', merged: false, count: 3 },
    ]);
    const progress = await computeProjectProgress('p1', db as never);
    if (!progress) throw new Error('expected a progress snapshot');
    expect(progress.done).toBe(54);
    expect(progress.inFlight).toBe(7);
    expect(progress.remaining).toBe(3);
    expect(progress.total).toBe(progress.done + progress.inFlight + progress.remaining);
    expect(progress.total).toBe(64);
  });

  it('two consecutive computes on unchanged data return identical numbers', async () => {
    const rows = [
      { status: 'closed', merged: true, count: 54 },
      { status: 'open', merged: false, count: 7 },
      { status: 'draft', merged: false, count: 3 },
    ];
    const a = await computeProjectProgress('p1', fakeDb(rows) as never);
    const b = await computeProjectProgress('p1', fakeDb(rows) as never);
    expect(a?.done).toBe(b?.done);
    expect(a?.inFlight).toBe(b?.inFlight);
    expect(a?.remaining).toBe(b?.remaining);
    expect(a?.total).toBe(b?.total);
  });

  it('an empty project returns all zeros, not null', async () => {
    const progress = await computeProjectProgress('empty', fakeDb([]) as never);
    expect(progress).toEqual(
      expect.objectContaining({ done: 0, inFlight: 0, remaining: 0, total: 0 }),
    );
  });

  it('released counts as done alongside closed', async () => {
    const db = fakeDb([
      { status: 'closed', merged: true, count: 2 },
      { status: 'released', merged: true, count: 5 },
    ]);
    const progress = await computeProjectProgress('p1', db as never);
    expect(progress?.done).toBe(7);
  });

  it('returns null (fail-closed) on a DB error', async () => {
    const progress = await computeProjectProgress('p1', failingDb() as never);
    expect(progress).toBeNull();
  });
});

describe('buildProgressFactsBlock', () => {
  it('renders the authoritative figures', () => {
    const block = buildProgressFactsBlock({
      done: 54,
      inFlight: 7,
      remaining: 3,
      total: 64,
      byStatus: {} as never,
      computedAt: new Date(),
    });
    expect(block).toContain('completed: 54');
    expect(block).toContain('in progress: 7');
    expect(block).toContain('not started: 3');
    expect(block).toContain('total: 64');
    expect(block).toMatch(/AUTHORITATIVE/);
  });
});
