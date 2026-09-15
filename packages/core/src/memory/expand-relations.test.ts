import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryHit } from './search.js';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];
// cm:why the prefix reader is a collaborator with a query shape of its own, stubbed so this file stays a check of what the module under test does with the reference rather than of how the prefix is read (ISS-992)
vi.mock('../issues/issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => null,
  heldIssuePrefixes: async () => [],
}));
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async (w: unknown) => {
            whereArgs.push(w);
            return selectQueue.shift() ?? [];
          },
        }),
        where: async (w: unknown) => {
          whereArgs.push(w);
          return selectQueue.shift() ?? [];
        },
      }),
    }),
  },
}));

type Digest = {
  kind: string;
  otherIssueId: string;
  expired: boolean;
};
const relations = new Map<string, { blocks: Digest[]; blockedBy: Digest[] }>();
// cm:guard the batched read is mocked as ONE call over the whole seed set, so a rewrite back to
// one read per seed fails on the call count rather than on a timing that nobody watches (ISS-1024)
const loadIssueRelationsForIssues = vi.fn(async (issueIds: string[], _projectId: string) => {
  return new Map(
    issueIds.map((id) => [id, relations.get(id) ?? { blocks: [], blockedBy: [] }] as const),
  );
});
vi.mock('../issues/dependency-read.js', () => ({
  loadIssueRelationsForIssues: (issueIds: string[], projectId: string) =>
    loadIssueRelationsForIssues(issueIds, projectId),
}));

const { EXPAND_SEED_LIMIT, expandIssueRelations } = await import('./expand-relations.js');

const PROJECT = '11111111-1111-4111-8111-111111111111';
const issueHit = (issueId: string, score = 0.5): MemoryHit => ({
  id: `mem-${issueId}`,
  source: 'issue',
  sourceRef: issueId,
  text: `issue ${issueId}`,
  metadata: {},
  score,
  embeddedAt: new Date(0),
  stale: false,
});
const memRow = (issueId: string) => ({
  id: `mem-${issueId}`,
  source: 'issue',
  sourceRef: issueId,
  text: `issue ${issueId}`,
  metadata: {},
  embeddedAt: new Date(0),
});
const edge = (otherIssueId: string, kind = 'blocks', expired = false): Digest => ({
  kind,
  otherIssueId,
  expired,
});

beforeEach(() => {
  selectQueue.length = 0;
  whereArgs.length = 0;
  relations.clear();
  loadIssueRelationsForIssues.mockClear();
});

describe('expandIssueRelations', () => {
  it('returns nothing when no ranked hit is an issue', async () => {
    const note: MemoryHit = { ...issueHit('x'), source: 'note' };
    expect(await expandIssueRelations({ projectId: PROJECT, hits: [note], topK: 5 })).toEqual([]);
    expect(loadIssueRelationsForIssues).not.toHaveBeenCalled();
  });

  it('appends both directions, unexpired blocks/relates only, labelled with the seed ISS-n and score 0', async () => {
    relations.set('A', {
      blocks: [edge('B'), edge('D', 'duplicates'), edge('E', 'relates', true)],
      blockedBy: [edge('C', 'relates')],
    });
    selectQueue.push([{ id: 'A', issSeq: 12 }]);
    selectQueue.push([memRow('B'), memRow('C')]);

    const out = await expandIssueRelations({ projectId: PROJECT, hits: [issueHit('A')], topK: 5 });

    expect(loadIssueRelationsForIssues).toHaveBeenCalledWith(['A'], PROJECT);
    expect(out.map((h) => h.sourceRef)).toEqual(['B', 'C']);
    expect(out.map((h) => h.via)).toEqual([
      { relation: 'blocks', from: 'ISS-12' },
      { relation: 'relates', from: 'ISS-12' },
    ]);
    expect(out.every((h) => h.score === 0)).toBe(true);
  });

  it('never re-adds an issue already ranked, never adds one twice, and stops at topK', async () => {
    relations.set('A', { blocks: [edge('B'), edge('C')], blockedBy: [] });
    relations.set('B', { blocks: [edge('C'), edge('D'), edge('E')], blockedBy: [] });
    selectQueue.push([
      { id: 'A', issSeq: 1 },
      { id: 'B', issSeq: 2 },
    ]);
    selectQueue.push([memRow('C'), memRow('D')]);

    const out = await expandIssueRelations({
      projectId: PROJECT,
      hits: [issueHit('A'), issueHit('B')],
      topK: 2,
    });

    expect(out.map((h) => h.sourceRef)).toEqual(['C', 'D']);
    expect(out[0]?.via).toEqual({ relation: 'blocks', from: 'ISS-1' });
  });

  it('reads edges for the first five issue hits only', async () => {
    const hits = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id) => issueHit(id));
    selectQueue.push(
      hits.slice(0, EXPAND_SEED_LIMIT).map((h, i) => ({ id: h.sourceRef, issSeq: i })),
    );
    await expandIssueRelations({ projectId: PROJECT, hits, topK: 10 });
    expect(loadIssueRelationsForIssues).toHaveBeenCalledTimes(1);
    expect(loadIssueRelationsForIssues).toHaveBeenCalledWith(['A', 'B', 'C', 'D', 'E'], PROJECT);
  });

  // cm:guard the edge read is ONE call however many seeds there are — it was one per seed until
  // ISS-1024, which with the label read and the hydration made twelve queries for every search
  it('reads the edges of five seeds in one call', async () => {
    const hits = ['A', 'B', 'C', 'D', 'E'].map((id) => issueHit(id));
    for (const h of hits) relations.set(h.sourceRef, { blocks: [edge('Z')], blockedBy: [] });
    selectQueue.push(hits.map((h, i) => ({ id: h.sourceRef, issSeq: i })));
    selectQueue.push([memRow('Z')]);

    await expandIssueRelations({ projectId: PROJECT, hits, topK: 10 });

    expect(loadIssueRelationsForIssues).toHaveBeenCalledTimes(1);
  });

  it('a neighbour without a memory row does not consume a topK slot', async () => {
    relations.set('A', { blocks: [edge('B'), edge('C')], blockedBy: [] });
    selectQueue.push([{ id: 'A', issSeq: 3 }]);
    selectQueue.push([memRow('C')]);
    const out = await expandIssueRelations({ projectId: PROJECT, hits: [issueHit('A')], topK: 1 });
    expect(out.map((h) => h.sourceRef)).toEqual(['C']);
  });

  it('skips a neighbour that has no memory row', async () => {
    relations.set('A', { blocks: [edge('B'), edge('C')], blockedBy: [] });
    selectQueue.push([{ id: 'A', issSeq: 3 }]);
    selectQueue.push([memRow('C')]);
    const out = await expandIssueRelations({ projectId: PROJECT, hits: [issueHit('A')], topK: 5 });
    expect(out.map((h) => h.sourceRef)).toEqual(['C']);
  });
});
