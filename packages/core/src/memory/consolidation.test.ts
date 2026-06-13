import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    LITELLM_API_URL: 'http://litellm.test',
    LITELLM_API_KEY: 'k',
    LITELLM_MODEL: 'fast-model',
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../queue/boss.js', () => ({ boss: {} }));

const indexMemoryMock = vi.fn();
const indexMemoryBestEffortMock = vi.fn();
vi.mock('./indexer.js', () => ({
  indexMemory: (input: unknown, opts?: unknown) => indexMemoryMock(input, opts),
  indexMemoryBestEffort: (input: unknown) => indexMemoryBestEffortMock(input),
}));

// Read chains differ: joins end in .limit(), the distinct-project query ends
// at .where(). Sequence-based stub: each select() call consumes the next
// queued result regardless of chain shape (thenable + .limit()).
const selectResults: unknown[][] = [];
const archiveUpdateMock = vi.fn();
vi.mock('../db/client.js', () => {
  const nextResult = () => Promise.resolve(selectResults.shift() ?? []);
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'orderBy']) {
      c[m] = () => c;
    }
    c.limit = () => nextResult();
    // biome-ignore lint/suspicious/noThenProperty: deliberate thenable mock of a drizzle query
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      nextResult().then(resolve, reject);
    return c;
  };
  return {
    db: {
      select: () => chain(),
      selectDistinct: () => chain(),
      update: () => ({
        set: () => ({
          where: (w: unknown) => ({ returning: () => archiveUpdateMock(w) }),
        }),
      }),
    },
  };
});

const { runConsolidationForProject } = await import('./consolidation.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function llmResponds(payload: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  indexMemoryMock.mockReset();
  indexMemoryBestEffortMock.mockReset();
  archiveUpdateMock.mockReset();
  selectResults.length = 0;
  indexMemoryMock.mockResolvedValue({
    id: 'm-new',
    embeddedAt: new Date(),
    truncated: false,
    degraded: false,
  });
  indexMemoryBestEffortMock.mockResolvedValue(undefined);
  archiveUpdateMock.mockResolvedValue([{ id: 'm-1' }]);
});

function queueSignal(opts?: {
  comments?: unknown[];
  statusChanges?: unknown[];
  memories?: unknown[];
}) {
  selectResults.push(opts?.comments ?? [{ body: 'review failed: wrong branch', issueTitle: 'X' }]);
  selectResults.push(opts?.statusChanges ?? []);
  selectResults.push(
    opts?.memories ?? [
      {
        id: 'm-1',
        source: 'note',
        sourceRef: 'n-1',
        textContent: 'old note about closed issue',
        metadata: {},
        retrievalCount: 0,
      },
    ],
  );
}

describe('runConsolidationForProject', () => {
  it('skips without an LLM call when there is no recent signal', async () => {
    queueSignal({ comments: [], statusChanges: [] });
    const result = await runConsolidationForProject(PROJECT_ID);
    expect(result.skipped).toBe('no-signal');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('executes capped create/update/archive actions and writes an audit decision', async () => {
    queueSignal();
    llmResponds({
      create: [{ content: 'deploy branch is master', category: 'correction' }],
      update: [{ id: 'm-1', newContent: 'merged cleaner note' }],
      archive: ['m-1'],
      summary: 'merged and cleaned',
    });

    const result = await runConsolidationForProject(PROJECT_ID);

    expect(result).toMatchObject({ created: 1, updated: 1, archived: 1, summary: 'merged and cleaned' });
    // create → knowledge row with dedup ON
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'knowledge',
        sourceRef: expect.stringMatching(/^consolidated:[0-9a-f]{12}$/),
      }),
      { semanticDedup: true },
    );
    // update → same natural key re-embedded
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'note', sourceRef: 'n-1', text: 'merged cleaner note' }),
      undefined,
    );
    // audit decision row
    expect(indexMemoryBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'decision' }),
    );
  });

  it('ignores archive/update ids that do not belong to the project memory set', async () => {
    queueSignal();
    llmResponds({
      create: [],
      update: [{ id: 'm-hallucinated', newContent: 'x' }],
      archive: ['m-hallucinated'],
      summary: 's',
    });

    const result = await runConsolidationForProject(PROJECT_ID);
    expect(result.updated).toBe(0);
    expect(result.archived).toBe(0);
    expect(archiveUpdateMock).not.toHaveBeenCalled();
  });

  it('tolerates a rambling non-JSON model output', async () => {
    queueSignal();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'I think we should...' } }] }),
    });
    const result = await runConsolidationForProject(PROJECT_ID);
    expect(result.skipped).toBe('parse-failed');
  });
});
