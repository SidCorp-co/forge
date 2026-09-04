import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryHit } from './search.js';

const selectQueue: unknown[][] = [];
const whereArgs: unknown[] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
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
const loadIssueRelations = vi.fn(async (issueId: string, _projectId: string) => {
  return relations.get(issueId) ?? { blocks: [], blockedBy: [] };
});
vi.mock('../issues/dependency-read.js', () => ({
  loadIssueRelations: (issueId: string, projectId: string) =>
    loadIssueRelations(issueId, projectId),
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
  loadIssueRelations.mockClear();
});

describe('expandIssueRelations', () => {
  it('returns nothing when no ranked hit is an issue', async () => {
    const note: MemoryHit = { ...issueHit('x'), source: 'note' };
    expect(await expandIssueRelations({ projectId: PROJECT, hits: [note], topK: 5 })).toEqual([]);
    expect(loadIssueRelations).not.toHaveBeenCalled();
  });

  it('appends both directions, unexpired blocks/relates only, labelled with the seed ISS-n and score 0', async () => {
    relations.set('A', {
      blocks: [edge('B'), edge('D', 'duplicates'), edge('E', 'relates', true)],
      blockedBy: [edge('C', 'relates')],
    });
    selectQueue.push([{ id: 'A', issSeq: 12 }]);
    selectQueue.push([memRow('B'), memRow('C')]);

    const out = await expandIssueRelations({ projectId: PROJECT, hits: [issueHit('A')], topK: 5 });

    expect(loadIssueRelations).toHaveBeenCalledWith('A', PROJECT);
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
    expect(loadIssueRelations).toHaveBeenCalledTimes(EXPAND_SEED_LIMIT);
    expect(loadIssueRelations).not.toHaveBeenCalledWith('F', PROJECT);
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
