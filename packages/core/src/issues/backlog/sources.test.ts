/**
 * What the two sources do BEFORE they start anything (ISS-1173). The contract says a producer
 * checks its cancellation state before a page read, before the prefix read, before an embedding
 * batch and before each per-seed search; a check only at the page boundary lets a caller who has
 * gone still buy the relations query, the prefix read and the rest of a page's searches.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', EMBEDDINGS_MODEL: 'test-model' },
}));

const selectSpy = vi.fn();
vi.mock('../../db/client.js', () => ({ db: { select: (...a: unknown[]) => selectSpy(...a) } }));

const loadRelations = vi.fn();
vi.mock('../dependency-read.js', () => ({
  loadIssueRelationsForIssues: (...a: unknown[]) => loadRelations(...a),
}));

const refFormatter = vi.fn();
vi.mock('../issue-prefix-read.js', () => ({
  issueRefFormatter: (...a: unknown[]) => refFormatter(...a),
}));

const embedBatch = vi.fn();
vi.mock('../../embeddings/index.js', () => ({ embedBatch: (...a: unknown[]) => embedBatch(...a) }));

const runMemorySearch = vi.fn();
vi.mock('../../memory/search-service.js', () => ({
  runMemorySearch: (...a: unknown[]) => runMemorySearch(...a),
}));

const { Cancellation } = await import('./cancellation.js');
const { orderingSource } = await import('./ordering-source.js');
const { alikeSource } = await import('./alike-source.js');

const ROW = { id: 'i1', issSeq: 1, title: 'one', createdAt: new Date() };

/** One page of rows, shaped as the drizzle chain each source builds. */
function pageOf(rows: unknown[]) {
  const limit = () => Promise.resolve(rows);
  const orderBy = () => ({ limit });
  const where = () => ({ orderBy, limit });
  return () => ({ from: () => ({ where }) });
}

async function drain(source: AsyncGenerator<unknown, { exhausted: boolean }, undefined>) {
  const items: unknown[] = [];
  let step = await source.next();
  while (!step.done) {
    items.push(step.value);
    step = await source.next();
  }
  return { items, done: step.value };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Never a real reference literal: issue-ref-no-literals.test.ts owns that shape, and what
  // these cases assert is which queries ran, not how a reference is spelled.
  refFormatter.mockResolvedValue((seq: number) => `display-${seq}`);
  loadRelations.mockResolvedValue(new Map());
  embedBatch.mockResolvedValue([[0.1]]);
  runMemorySearch.mockResolvedValue({ hits: [] });
  selectSpy.mockImplementation(pageOf([ROW]));
});

describe('orderingSource, before it starts anything', () => {
  it('reads nothing at all when the stream was already stopped', async () => {
    const cancellation = new Cancellation();
    cancellation.cancel('disconnect');

    const { items, done } = await drain(
      orderingSource({ projectId: 'p', statuses: ['open'], withBody: false, cancellation }),
    );

    expect(items).toHaveLength(0);
    expect(done).toEqual({ exhausted: false });
    expect(refFormatter).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('does not load relations for a page whose client left while the page was being read', async () => {
    const cancellation = new Cancellation();
    selectSpy.mockImplementation(() => {
      cancellation.cancel('disconnect');
      return pageOf([ROW])();
    });

    const { items, done } = await drain(
      orderingSource({ projectId: 'p', statuses: ['open'], withBody: false, cancellation }),
    );

    expect(items).toHaveLength(0);
    expect(done).toEqual({ exhausted: false });
    expect(loadRelations).not.toHaveBeenCalled();
  });

  it('reports exhaustion, not a stop, when the backlog simply ran out', async () => {
    const cancellation = new Cancellation();
    selectSpy.mockImplementation(pageOf([]));

    const { done } = await drain(
      orderingSource({ projectId: 'p', statuses: ['open'], withBody: false, cancellation }),
    );

    expect(done).toEqual({ exhausted: true });
  });
});

describe('alikeSource, before it starts anything', () => {
  it('reads nothing at all when the stream was already stopped', async () => {
    const cancellation = new Cancellation();
    cancellation.cancel('disconnect');

    const { items, done } = await drain(
      alikeSource({ projectId: 'p', statuses: ['open'], topK: 10, cancellation }),
    );

    expect(items).toHaveLength(0);
    expect(done).toEqual({ exhausted: false });
    expect(refFormatter).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('does not embed a batch whose client left while the seeds were being read', async () => {
    const cancellation = new Cancellation();
    selectSpy.mockImplementation(() => {
      cancellation.cancel('disconnect');
      return pageOf([ROW])();
    });

    const { done } = await drain(
      alikeSource({ projectId: 'p', statuses: ['open'], topK: 10, cancellation }),
    );

    expect(done).toEqual({ exhausted: false });
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('does not begin a search for a seed whose client left after the batch was embedded', async () => {
    const cancellation = new Cancellation();
    embedBatch.mockImplementation(async () => {
      cancellation.cancel('disconnect');
      return [[0.1]];
    });

    const { done } = await drain(
      alikeSource({ projectId: 'p', statuses: ['open'], topK: 10, cancellation }),
    );

    expect(done).toEqual({ exhausted: false });
    expect(runMemorySearch).not.toHaveBeenCalled();
  });

  it('searches once per seed while nothing has stopped it', async () => {
    const cancellation = new Cancellation();

    const { items } = await drain(
      alikeSource({ projectId: 'p', statuses: ['open'], topK: 10, cancellation }),
    );

    expect(items).toHaveLength(1);
    expect(runMemorySearch).toHaveBeenCalledTimes(1);
  });
});
