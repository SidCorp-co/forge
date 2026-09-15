/**
 * ISS-1017 — `loadIssueDependencyEdgesForIssues`: the page-wide read that
 * replaced the issues list's per-row `GET /issues/:id/dependencies`.
 *
 * The db is a recording stub, so what is asserted is the query this module
 * BUILDS — one of them, carrying the `project_id` predicate the composite
 * indexes need — and how it files the rows that come back. The predicate is
 * read off drizzle's own SQL chunks rather than a string, because a `where`
 * that dropped `project_id` would still be a valid query.
 */

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:why the prefix reader is a collaborator with a query shape of its own; here it is a fixture that answers a DIFFERENT prefix per project, which is what makes the cross-project naming case able to fail — and a spy, because the display ids come out right whether it was asked once per project or once per row
const prefixes: Record<string, string | null> = {};
const activeIssuePrefix = vi.fn(async (id: string) => prefixes[id] ?? null);
vi.mock('./issue-prefix-read.js', () => ({
  activeIssuePrefix,
  heldIssuePrefixes: async () => [],
}));

let rows: Record<string, unknown>[] = [];
const whereArgs: unknown[] = [];
const selectWhere = vi.fn((arg: unknown) => {
  whereArgs.push(arg);
  return Promise.resolve(rows);
});
const selectLeftJoin = vi.fn(
  (): Record<string, unknown> => ({ leftJoin: selectLeftJoin, where: selectWhere }),
);
const selectFrom = vi.fn(() => ({ leftJoin: selectLeftJoin, where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));
vi.mock('../db/client.js', () => ({ db: { select: dbSelect } }));

const { loadIssueDependencyEdgesForIssues, loadIssueDependencyEdges } = await import(
  './dependency-read.js'
);

const PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const edge = (over: Record<string, unknown>) => ({
  id: 'e1',
  projectId: PROJECT,
  fromIssueId: A,
  toIssueId: B,
  kind: 'blocks',
  reason: null,
  createdById: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  validUntil: null,
  fromIssSeq: 1,
  fromProjectId: PROJECT,
  fromTitle: 'a',
  fromStatus: 'open',
  fromMergedAt: null,
  toIssSeq: 2,
  toProjectId: PROJECT,
  toTitle: 'b',
  toStatus: 'closed',
  toMergedAt: null,
  ...over,
});

/** The WHERE this module built, rendered as the SQL Postgres would plan. */
const renderedWhere = () => new PgDialect().sqlToQuery(whereArgs[0] as SQL);

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  whereArgs.length = 0;
  for (const k of Object.keys(prefixes)) delete prefixes[k];
});

describe('one query for the whole page', () => {
  it('reads issue_dependencies once for a 25-id page, not once per id', async () => {
    const ids = Array.from(
      { length: 25 },
      (_, i) => `${`${i}`.padStart(8, '0')}-0000-4000-8000-000000000000`,
    );
    await loadIssueDependencyEdgesForIssues(ids, PROJECT);
    expect(dbSelect).toHaveBeenCalledTimes(1);
    expect(selectWhere).toHaveBeenCalledTimes(1);
  });

  it('runs no query at all for an empty page', async () => {
    const out = await loadIssueDependencyEdgesForIssues([], PROJECT);
    expect(dbSelect).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  // cm:guard this is the index case: `issue_dependencies` carries only (project_id, from_issue_id) and (project_id, to_issue_id), so a WHERE without project_id constrains the non-leading column of both and Postgres seq-scans every edge in the table
  it('constrains project_id alongside the two endpoint columns', async () => {
    await loadIssueDependencyEdgesForIssues([A, B], PROJECT);
    const { sql, params } = renderedWhere();
    expect(sql).toContain('"issue_dependencies"."project_id" =');
    expect(sql).toContain('"issue_dependencies"."from_issue_id" in');
    expect(sql).toContain('"issue_dependencies"."to_issue_id" in');
    expect(params).toContain(PROJECT);
    expect(params).toContain(A);
    expect(params).toContain(B);
  });
});

describe('an edge is filed against the row that owns its side', () => {
  it("lands on the from-row's outgoing", async () => {
    rows = [edge({})];
    const out = await loadIssueDependencyEdgesForIssues([A], PROJECT);
    expect(out.get(A)?.outgoing.map((e) => e.id)).toEqual(['e1']);
    expect(out.get(A)?.incoming).toEqual([]);
  });

  it("lands on the to-row's incoming", async () => {
    rows = [edge({})];
    const out = await loadIssueDependencyEdgesForIssues([B], PROJECT);
    expect(out.get(B)?.incoming.map((e) => e.id)).toEqual(['e1']);
    expect(out.get(B)?.outgoing).toEqual([]);
  });

  // cm:guard file it once and one of the two rows renders a badge the other one owns — this is the case a single `find the id` loop gets wrong
  it('lands on BOTH rows when both endpoints are on the page', async () => {
    rows = [edge({})];
    const out = await loadIssueDependencyEdgesForIssues([A, B], PROJECT);
    expect(out.get(A)?.outgoing.map((e) => e.id)).toEqual(['e1']);
    expect(out.get(B)?.incoming.map((e) => e.id)).toEqual(['e1']);
    expect(out.get(A)?.incoming).toEqual([]);
    expect(out.get(B)?.outgoing).toEqual([]);
  });

  it('gives a requested row with no edge both arrays, never a missing entry', async () => {
    rows = [edge({})];
    const out = await loadIssueDependencyEdgesForIssues([A, B, C], PROJECT);
    expect(out.has(C)).toBe(true);
    expect(out.get(C)).toEqual({ outgoing: [], incoming: [] });
  });

  // cm:guard a self-edge is filed ONCE, outgoing, which is what the single-issue loader's `from === issueId ? outgoing : incoming` did before this batch existed. No writer can create one — `dependency-service` throws SELF_DEP — so the case only exists for a row already in the table, and filing it on both sides would render the issue as blocking and blocked by itself.
  it('files a self-edge once, on the outgoing side', async () => {
    rows = [edge({ fromIssueId: A, toIssueId: A, toIssSeq: 1 })];
    const out = await loadIssueDependencyEdgesForIssues([A], PROJECT);
    expect(out.get(A)?.outgoing.map((e) => e.id)).toEqual(['e1']);
    expect(out.get(A)?.incoming).toEqual([]);
  });

  it('files no edge against a row that was not asked for', async () => {
    rows = [edge({ fromIssueId: C, toIssueId: A })];
    const out = await loadIssueDependencyEdgesForIssues([A], PROJECT);
    expect(out.has(C)).toBe(false);
    expect(out.get(A)?.incoming.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('each endpoint is named with its own project prefix', () => {
  // cm:guard naming a cross-project blocker under the page project's prefix reports a DIFFERENT issue that exists, which is why the edge's project_id scope and the endpoint's project are read separately (codex review of ISS-992)
  it('names an endpoint in another project with that project prefix', async () => {
    prefixes[PROJECT] = 'FD';
    prefixes[OTHER_PROJECT] = 'FX';
    rows = [edge({ toProjectId: OTHER_PROJECT, toIssSeq: 7 })];
    const out = await loadIssueDependencyEdgesForIssues([A], PROJECT);
    const [e] = out.get(A)?.outgoing ?? [];
    expect(e?.fromDisplayId).toBe('FD-1');
    expect(e?.toDisplayId).toBe('FX-7');
  });

  // cm:guard this counts the CALLS, not the display ids: `readPrefixes` iterating the raw endpoint list instead of the distinct set names every reference correctly and turns one prefix read into two per edge — a page-sized N+1 one level down from the one this change removed, with nothing in the payload to show for it
  it('reads one prefix per distinct project, not one per row', async () => {
    prefixes[PROJECT] = 'FD';
    prefixes[OTHER_PROJECT] = 'FX';
    rows = [
      edge({}),
      edge({ id: 'e2', fromIssueId: C, toIssueId: A, fromIssSeq: 3 }),
      edge({ id: 'e3', toProjectId: OTHER_PROJECT, toIssSeq: 7 }),
    ];
    const out = await loadIssueDependencyEdgesForIssues([A, B, C], PROJECT);
    expect(out.get(A)?.outgoing[0]?.toDisplayId).toBe('FD-2');
    expect(out.get(A)?.incoming[0]?.fromDisplayId).toBe('FD-3');
    expect(activeIssuePrefix).toHaveBeenCalledTimes(2);
    expect(activeIssuePrefix.mock.calls.map(([id]) => id).sort()).toEqual(
      [PROJECT, OTHER_PROJECT].sort(),
    );
  });
});

describe('the single-issue read is this one with a page of one', () => {
  it('returns the same two arrays for the issue asked about', async () => {
    rows = [edge({})];
    const out = await loadIssueDependencyEdges(A, PROJECT);
    expect(out.outgoing.map((e) => e.id)).toEqual(['e1']);
    expect(out.incoming).toEqual([]);
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });

  it('answers both arrays empty when the issue has no edges', async () => {
    rows = [];
    expect(await loadIssueDependencyEdges(A, PROJECT)).toEqual({ outgoing: [], incoming: [] });
  });
});
