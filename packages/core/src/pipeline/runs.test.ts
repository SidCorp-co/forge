/**
 * ISS-101 — unit tests for the pipeline_runs lifecycle helpers. The helpers
 * are thin wrappers over `db.insert/update`, so the contract under test is
 * "what shape of write does each helper issue, under which preconditions?".
 * Heavy integration coverage (migration backfill, picker ordering against a
 * real DB) lives in dispatch-tick.test.ts and the migration smoke tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type InsertCall = {
  values: Record<string, unknown>;
  conflict?: { target?: unknown; where?: unknown };
  returningRows: Record<string, unknown>[];
};
type UpdateCall = { set: Record<string, unknown> };

const insertCalls: InsertCall[] = [];
const updateCalls: UpdateCall[] = [];
// Each `selectOpenIssueRun` is shaped as a chain ending in `.limit(...)`.
// The queue holds one [row]-or-[] response per call.
const selectResponses: Array<Record<string, unknown>[]> = [];
// Toggle: should the next `.returning()` after onConflictDoNothing return
// an empty array (i.e. the loser of an onConflict race)? Mirrors what
// Postgres does on a real duplicate.
let nextInsertReturnsEmpty = false;

vi.mock('../db/schema.js', () => ({
  pipelineRuns: { name: 'pipeline_runs' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  inArray: (...args: unknown[]) => ({ _inArray: args }),
  sql: ((strings: TemplateStringsArray, ...values: unknown[]) => ({
    _sql: strings.join('?'),
    values,
  })) as never,
}));

vi.mock('../db/client.js', () => ({
  db: {
    insert: () => {
      const call: InsertCall = { values: {}, returningRows: [] };
      let captured: InsertCall = call;
      const chain = {
        values(v: Record<string, unknown>) {
          captured.values = v;
          return chain;
        },
        onConflictDoNothing(opts: { target?: unknown; where?: unknown }) {
          captured.conflict = opts;
          return chain;
        },
        returning(_cols?: unknown) {
          // Resolve based on the global toggle.
          const rows = nextInsertReturnsEmpty
            ? []
            : [{ id: 'run-new', startedAt: new Date('2026-05-12T08:00:00Z') }];
          captured.returningRows = rows;
          insertCalls.push(captured);
          return Promise.resolve(rows);
        },
      };
      return chain;
    },
    update: () => {
      const chain = {
        set(s: Record<string, unknown>) {
          updateCalls.push({ set: s });
          return {
            where: () => Promise.resolve(undefined),
          };
        },
      };
      return chain;
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResponses.shift() ?? []),
        }),
      }),
    }),
  },
}));

const {
  openIssueRun,
  openOneShotRun,
  setCurrentStep,
  setCurrentStepForOpenIssueRun,
  closeRun,
  closeRunIfOneShot,
  closeOpenRunForIssue,
} = await import('./runs.js');

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  selectResponses.length = 0;
  nextInsertReturnsEmpty = false;
});

describe('openIssueRun', () => {
  it('returns the existing open run when one is already present (no INSERT)', async () => {
    selectResponses.push([{ id: 'run-existing', startedAt: new Date('2026-05-10T00:00:00Z') }]);
    const r = await openIssueRun({ projectId: 'p-1', issueId: 'i-1' });
    expect(r.id).toBe('run-existing');
    expect(insertCalls).toHaveLength(0);
  });

  it('INSERTs with ON CONFLICT DO NOTHING + returning when no open run exists', async () => {
    selectResponses.push([]); // first select — no existing run
    const r = await openIssueRun({ projectId: 'p-1', issueId: 'i-1' });
    expect(r.id).toBe('run-new');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.values).toMatchObject({
      projectId: 'p-1',
      issueId: 'i-1',
      kind: 'issue',
      status: 'running',
    });
    // Must use the partial unique index as the conflict target so concurrent
    // callers race safely.
    expect(insertCalls[0]?.conflict).toBeDefined();
  });

  it('re-selects on ON CONFLICT loss and returns the winner (race-safe)', async () => {
    selectResponses.push([]); // initial select — no row
    selectResponses.push([
      { id: 'run-winner', startedAt: new Date('2026-05-12T07:00:00Z') },
    ]); // post-conflict select returns winner
    nextInsertReturnsEmpty = true;
    const r = await openIssueRun({ projectId: 'p-1', issueId: 'i-1' });
    expect(r.id).toBe('run-winner');
  });

  it('throws when ON CONFLICT loses AND the winner cannot be re-selected (defensive)', async () => {
    selectResponses.push([]); // initial select — no row
    selectResponses.push([]); // post-conflict select — also empty (shouldn't happen)
    nextInsertReturnsEmpty = true;
    await expect(openIssueRun({ projectId: 'p-1', issueId: 'i-1' })).rejects.toThrow(
      /no row after ON CONFLICT DO NOTHING/,
    );
  });
});

describe('openOneShotRun', () => {
  it('inserts a kind=pm run with issueId NULL and metadata', async () => {
    const r = await openOneShotRun({ projectId: 'p-1', kind: 'pm', metadata: { src: 'unit' } });
    expect(r.id).toBe('run-new');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.values).toMatchObject({
      projectId: 'p-1',
      issueId: null,
      kind: 'pm',
      status: 'running',
      metadata: { src: 'unit' },
    });
  });

  it('defaults metadata to empty object when omitted', async () => {
    await openOneShotRun({ projectId: 'p-1', kind: 'interactive' });
    expect(insertCalls[0]?.values.metadata).toEqual({});
  });

  it('supports kind=system for project-scoped one-shots without an issue', async () => {
    await openOneShotRun({ projectId: 'p-1', kind: 'system' });
    expect(insertCalls[0]?.values.kind).toBe('system');
  });
});

describe('setCurrentStep / setCurrentStepForOpenIssueRun', () => {
  it('setCurrentStep updates current_step and bumps updatedAt', async () => {
    await setCurrentStep('run-1', 'plan');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.set.currentStep).toBe('plan');
    expect(updateCalls[0]?.set.updatedAt).toBeInstanceOf(Date);
  });

  it('setCurrentStepForOpenIssueRun issues an UPDATE filtered to running/paused issue runs', async () => {
    await setCurrentStepForOpenIssueRun('i-1', 'developed');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.set.currentStep).toBe('developed');
  });
});

describe('closeRun / closeRunIfOneShot / closeOpenRunForIssue', () => {
  it('closeRun stamps status, finishedAt, updatedAt', async () => {
    await closeRun('run-1', 'completed');
    expect(updateCalls[0]?.set).toMatchObject({ status: 'completed' });
    expect(updateCalls[0]?.set.finishedAt).toBeInstanceOf(Date);
    expect(updateCalls[0]?.set.updatedAt).toBeInstanceOf(Date);
  });

  it('closeRunIfOneShot supports all three terminal outcomes', async () => {
    await closeRunIfOneShot('run-1', 'completed');
    await closeRunIfOneShot('run-1', 'failed');
    await closeRunIfOneShot('run-1', 'cancelled');
    expect(updateCalls.map((c) => c.set.status)).toEqual(['completed', 'failed', 'cancelled']);
  });

  it('closeOpenRunForIssue closes by issueId for kind=issue runs', async () => {
    await closeOpenRunForIssue('i-1', 'completed');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.set.status).toBe('completed');
  });
});
