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
  },
}));

const { loadIssueRelations, loadIssueRelationsForIssues } = await import('./dependency-read.js');

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
    expect(out.get('Z')).toEqual({ blocks: [], blockedBy: [] });
  });

  // cm:guard the parity is the point: `loadIssueRelations` IS this function called with one id, so
  // what a relation says has one writer and cannot drift between the batched and single callers
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

  // cm:guard these rows are inlined into an agent's context WITHOUT the untrusted-data framing the issue's own fields get, so the digest carries ids, kind and expiry and never caller-authored text from another issue — a title, a description or an edge `reason`
  it('carries no issue title, no issue description and no edge reason', async () => {
    edgeRows = [edgeRow()];
    const out = await loadIssueRelationsForIssues(['A'], PROJECT);
    const digest = out.get('A')?.blocks[0];
    expect(digest).toBeDefined();
    const keys = Object.keys(digest as object).sort();
    expect(keys).toEqual([
      'edgeId',
      'expired',
      'fromIssueId',
      'kind',
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
    const blocks = (await loadIssueRelationsForIssues(['A'], PROJECT)).get('A')?.blocks ?? [];
    expect(blocks.map((b) => [b.edgeId, b.expired])).toEqual([
      ['gone', true],
      ['live', false],
    ]);
  });
});
