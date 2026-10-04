/**
 * ISS-1024 — `loadIssueRelationsForIssues` is the agent-facing relation digest over a SET of
 * issues off the one batched edge query, and `loadIssueRelations` is it called with a set of one.
 *
 * `memory/expand-relations.ts` called the single-issue read once per seed, which with five seeds
 * meant ten edge queries plus a label read plus the hydration — twelve queries for one search.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => 'ISS',
  heldIssuePrefixes: async () => [],
}));

let edgeRows: Array<Record<string, unknown>> = [];
const selects = vi.fn();
vi.mock('../db/client.js', () => ({
  db: {
    select: () => {
      selects();
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.leftJoin = () => chain;
      chain.where = async () => edgeRows;
      return chain;
    },
    execute: async () => [],
  },
}));

const {
  emptyIssueRelations,
  loadIssueDependencyEdges,
  loadIssueRelations,
  loadIssueRelationsForIssues,
} = await import('./dependency-read.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

const edgeRow = (over: Record<string, unknown> = {}) => ({
  id: 'edge-1',
  projectId: PROJECT,
  fromIssueId: 'A',
  toIssueId: 'B',
  kind: 'blocks',
  reason: 'because the schema moves first',
  createdById: null,
  createdAt: new Date(0),
  validUntil: null,
  fromIssSeq: 1,
  fromProjectId: PROJECT,
  fromTitle: 'A title nobody should inline',
  fromStatus: 'open',
  fromMergedAt: null,
  toIssSeq: 2,
  toProjectId: PROJECT,
  toTitle: 'B title nobody should inline',
  toStatus: 'closed',
  toMergedAt: null,
  ...over,
});

beforeEach(() => {
  selects.mockClear();
  edgeRows = [];
});

describe('loadIssueRelationsForIssues', () => {
  it('reads the edges of five issues in one query', async () => {
    await loadIssueRelationsForIssues(['A', 'B', 'C', 'D', 'E'], PROJECT);
    expect(selects).toHaveBeenCalledTimes(1);
  });

  it('gives every requested id an entry, an issue with no edge included', async () => {
    const out = await loadIssueRelationsForIssues(['A', 'B', 'Z'], PROJECT);
    expect([...out.keys()].sort()).toEqual(['A', 'B', 'Z']);
    expect(out.get('Z')).toEqual(emptyIssueRelations());
    expect(Object.keys(out.get('Z') ?? {}).sort()).toEqual([
      'blockedBy',
      'blocks',
      'decomposes',
      'duplicates',
      'parent',
      'relates',
    ]);
  });

  it('returns, for each seed, what the single-issue read returns for that seed', async () => {
    edgeRows = [
      edgeRow(),
      edgeRow({ id: 'edge-2', fromIssueId: 'C', toIssueId: 'A', kind: 'relates' }),
    ];

    const batched = await loadIssueRelationsForIssues(['A', 'C'], PROJECT);
    const singleA = await loadIssueRelations('A', PROJECT);
    const singleC = await loadIssueRelations('C', PROJECT);

    expect(batched.get('A')).toEqual(singleA);
    expect(batched.get('C')).toEqual(singleC);
  });

  it('carries no issue title, no issue description and no edge reason', async () => {
    edgeRows = [edgeRow()];
    const out = await loadIssueRelationsForIssues(['A'], PROJECT);
    const digest = out.get('A')?.blocks.outgoing[0];
    expect(digest).toBeDefined();
    const keys = Object.keys(digest as object).sort();
    expect(keys).toEqual([
      'blocking',
      'edgeId',
      'expired',
      'fromIssueId',
      'gatesDispatch',
      'kind',
      'otherDesignHold',
      'otherDisplayId',
      'otherIssueId',
      'otherMergedAt',
      'otherStatus',
      'toIssueId',
      'validUntil',
    ]);
    expect(JSON.stringify(digest)).not.toContain('nobody should inline');
    expect(JSON.stringify(digest)).not.toContain('schema moves first');
  });

  it('marks an edge past its validUntil expired and one still in date not', async () => {
    edgeRows = [
      edgeRow({ id: 'gone', validUntil: PAST }),
      edgeRow({ id: 'live', toIssueId: 'C', validUntil: FUTURE }),
    ];
    const blocks =
      (await loadIssueRelationsForIssues(['A'], PROJECT)).get('A')?.blocks.outgoing ?? [];
    expect(blocks.map((b) => [b.edgeId, b.expired, b.blocking])).toEqual([
      ['gone', true, false],
      ['live', false, true],
    ]);
  });

  it('files every kind under its own key, so only a blocks edge is ever read as blocking', async () => {
    edgeRows = [
      edgeRow({ id: 'b', fromIssueId: 'X', toIssueId: 'A', kind: 'blocks' }),
      edgeRow({ id: 'r', fromIssueId: 'X', toIssueId: 'A', kind: 'relates' }),
      edgeRow({ id: 'd', fromIssueId: 'X', toIssueId: 'A', kind: 'duplicates' }),
      edgeRow({ id: 'p', fromIssueId: 'X', toIssueId: 'A', kind: 'parent' }),
      edgeRow({ id: 'c', fromIssueId: 'A', toIssueId: 'Y', kind: 'decomposes' }),
    ];
    const a = (await loadIssueRelationsForIssues(['A'], PROJECT)).get('A');
    expect(a?.blocks.incoming.map((e) => e.edgeId)).toEqual(['b']);
    expect(a?.relates.incoming.map((e) => e.edgeId)).toEqual(['r']);
    expect(a?.duplicates.incoming.map((e) => e.edgeId)).toEqual(['d']);
    expect(a?.parent.incoming.map((e) => e.edgeId)).toEqual(['p']);
    expect(a?.decomposes.outgoing.map((e) => e.edgeId)).toEqual(['c']);
    const { blockedBy: _legacy, ...byKind } = a ?? ({} as NonNullable<typeof a>);
    const blocking = Object.values(byKind)
      .flatMap((d) => [...d.outgoing, ...d.incoming])
      .filter((e) => e.blocking)
      .map((e) => e.edgeId);
    expect(blocking).toEqual(['b']);
  });

  it('flags a retracted edge expired on the edge list the list and detail render from', async () => {
    edgeRows = [
      edgeRow({ id: 'gone', fromIssueId: 'X', toIssueId: 'A', validUntil: PAST }),
      edgeRow({ id: 'live', fromIssueId: 'Y', toIssueId: 'A', validUntil: null }),
    ];
    const { incoming } = await loadIssueDependencyEdges('A', PROJECT);
    expect(incoming.map((e) => [e.id, e.expired])).toEqual([
      ['gone', true],
      ['live', false],
    ]);
  });

  // cm:hack plugin-followups.md — the pinned forge-plugin reads only `relations.blockedBy`.
  it('keeps the legacy blockedBy key, holding only live blocks edges', async () => {
    edgeRows = [
      edgeRow({ id: 'live', fromIssueId: 'X', toIssueId: 'A', kind: 'blocks' }),
      edgeRow({ id: 'rel', fromIssueId: 'X', toIssueId: 'A', kind: 'relates' }),
      edgeRow({ id: 'gone', fromIssueId: 'Y', toIssueId: 'A', kind: 'blocks', validUntil: PAST }),
      edgeRow({ id: 'out', fromIssueId: 'A', toIssueId: 'Z', kind: 'blocks' }),
    ];
    const a = (await loadIssueRelationsForIssues(['A'], PROJECT)).get('A');
    expect(a?.blockedBy.map((e) => e.edgeId)).toEqual(['live']);
  });
});
