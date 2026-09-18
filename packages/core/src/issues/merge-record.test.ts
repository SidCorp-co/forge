/**
 * ISS-1073 — the one writer, and the asymmetry between its two predicates.
 *
 * The property under test is not "an UPDATE happened": it is WHICH column the
 * statement gates on, because that single difference is what lets a merge Forge
 * later observes replace a stamp somebody asserted, while leaving evidence
 * already recorded alone. A test that only counted updates would stay green
 * through a flattening of the two predicates into one, which is the mistake the
 * module's own guard names.
 */

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { clearIssueMerge, recordIssueMerge } from './merge-record.js';

/** The SQL a drizzle predicate actually renders to, as Postgres would receive it. */
// cm:guard the predicate is RENDERED rather than walked, and never inferred from a row the mock returned: a mock decides what comes back and cannot decide what was asked. An earlier version of this helper walked the fragment's object graph and reached every column of `issues` through a column's own `.table` back-reference, so it proved nothing. This is what makes criteria 14 and 16 provable without a database.
function renderedSql(fragment: unknown): string {
  return new PgDialect().sqlToQuery(fragment as SQL).sql;
}

function buildExecutor(spec: { returningRows?: unknown[]; heldRow?: unknown } = {}) {
  const setCall = vi.fn();
  const whereCall = vi.fn();
  const update = vi.fn().mockReturnValue({
    set: (payload: unknown) => {
      setCall(payload);
      return {
        where: (predicate: unknown) => {
          whereCall(predicate);
          return {
            returning: async () =>
              spec.returningRows ?? [
                { mergedAt: new Date('2026-09-18T06:30:01Z'), mergedCommitSha: 'e45b4ec' },
              ],
          };
        },
      };
    },
  });
  const select = vi.fn().mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => (spec.heldRow ? [spec.heldRow] : []),
        orderBy: () => ({ limit: async () => (spec.heldRow ? [spec.heldRow] : []) }),
      }),
    }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: ad-hoc executor shape
  return { executor: { update, select } as any, setCall, whereCall };
}

const OBSERVED = {
  kind: 'observed',
  commitSha: 'e45b4ecf596c58e10135c25af4f7279a0a804802',
  mergedAt: new Date('2026-09-18T06:30:01.449Z'),
  via: 'kernel',
} as const;

describe('recordIssueMerge — an assertion', () => {
  it('gates on merged_at, so the first stamp wins', async () => {
    const { executor, whereCall } = buildExecutor();
    await recordIssueMerge(executor, {
      issueId: 'iss-1',
      evidence: { kind: 'asserted', via: 'mark' },
    });
    const gated = renderedSql(whereCall.mock.calls[0]?.[0]);
    expect(gated).toContain('"merged_at" is null');
    expect(gated).not.toContain('merged_commit_sha');
  });

  it('writes no commit sha at all', async () => {
    const { executor, setCall } = buildExecutor();
    await recordIssueMerge(executor, {
      issueId: 'iss-1',
      evidence: { kind: 'asserted', via: 'close' },
    });
    expect(setCall.mock.calls[0]?.[0]).not.toHaveProperty('mergedCommitSha');
  });

  it('takes the caller-supplied time when it names one', async () => {
    const { executor, setCall } = buildExecutor();
    await recordIssueMerge(executor, {
      issueId: 'iss-1',
      evidence: { kind: 'asserted', at: new Date('2026-09-17T12:17:12.321Z'), via: 'mark' },
    });
    const payload = setCall.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const written = JSON.stringify(payload?.mergedAt);
    expect(written).toContain('2026-09-17T12:17:12.321Z');
  });

  it('reports wrote=false and the held values when the row already carries a stamp', async () => {
    const held = { mergedAt: new Date('2026-09-01T00:00:00Z'), mergedCommitSha: 'abc1234' };
    const { executor } = buildExecutor({ returningRows: [], heldRow: held });
    const result = await recordIssueMerge(executor, {
      issueId: 'iss-1',
      evidence: { kind: 'asserted', via: 'mark' },
    });
    expect(result).toEqual({ wrote: false, mergedAt: held.mergedAt, commitSha: 'abc1234' });
  });
});

describe('recordIssueMerge — evidence', () => {
  // cm:guard this is the planted violation for criteria 14 and 16. Change the evidence arm's gate to `merged_at IS NULL` — the obvious "make both predicates the same" edit — and this goes red naming `merged_commit_sha`, because an issue somebody marked by hand could then never receive the evidence of its own merge.
  it('gates on merged_commit_sha, so it replaces an assertion and not another evidence', async () => {
    const { executor, whereCall } = buildExecutor();
    await recordIssueMerge(executor, { issueId: 'iss-1', evidence: OBSERVED });
    const gated = renderedSql(whereCall.mock.calls[0]?.[0]);
    expect(gated).toContain('"merged_commit_sha" is null');
    expect(gated).not.toContain('"merged_at" is null');
  });

  it('writes the commit GitHub reported', async () => {
    const { executor, setCall } = buildExecutor();
    await recordIssueMerge(executor, { issueId: 'iss-1', evidence: OBSERVED });
    expect(setCall.mock.calls[0]?.[0]).toMatchObject({ mergedCommitSha: OBSERVED.commitSha });
  });

  it("takes the merge's own time, not the server clock", async () => {
    const { executor, setCall } = buildExecutor();
    await recordIssueMerge(executor, { issueId: 'iss-1', evidence: OBSERVED });
    const payload = setCall.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const written = JSON.stringify(payload?.mergedAt);
    expect(written).toContain('2026-09-18T06:30:01.449Z');
    expect(written).not.toContain('now()');
  });

  it('reports wrote=false and the recorded evidence when evidence is already there', async () => {
    const held = { mergedAt: new Date('2026-09-18T06:30:01Z'), mergedCommitSha: 'deadbee' };
    const { executor } = buildExecutor({ returningRows: [], heldRow: held });
    const result = await recordIssueMerge(executor, { issueId: 'iss-1', evidence: OBSERVED });
    expect(result).toEqual({ wrote: false, mergedAt: held.mergedAt, commitSha: 'deadbee' });
  });
});

describe('clearIssueMerge', () => {
  it('clears the commit together with the timestamp', async () => {
    const { executor, setCall } = buildExecutor();
    await clearIssueMerge(executor, 'iss-1');
    expect(setCall.mock.calls[0]?.[0]).toMatchObject({ mergedAt: null, mergedCommitSha: null });
  });
});
