// cm:guard the db stub is ORDER-SENSITIVE: each db.select() consumes the next queued result, and `proposeKnowledgePromotions` now does three in a row — config, project creator, candidates. Adding a query without queueing a row for it steals the next one silently rather than failing where the gap is.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const indexMemoryMock = vi.fn();
vi.mock('./indexer.js', () => ({
  indexMemory: (input: unknown, opts?: unknown) => indexMemoryMock(input, opts),
}));

const selectResults: unknown[][] = [];
const insertReturningMock = vi.fn();
const insertValuesMock = vi.fn();
vi.mock('../db/client.js', () => {
  const nextResult = () => Promise.resolve(selectResults.shift() ?? []);
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where']) c[m] = () => c;
    c.limit = () => nextResult();
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      nextResult().then(resolve, reject);
    return c;
  };
  return {
    db: {
      select: () => chain(),
      insert: () => ({
        values: (v: unknown) => {
          insertValuesMock(v);
          return { returning: insertReturningMock };
        },
      }),
    },
  };
});

const {
  proposeKnowledgePromotions,
  resolveKnowledgePromotion,
  PROMOTION_RETRIEVAL_MIN,
  PROMOTION_AGE_DAYS,
  PROMOTION_CANDIDATES_PER_RUN,
} = await import('./knowledge-promotion.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  selectResults.length = 0;
  indexMemoryMock.mockReset();
  insertReturningMock.mockReset();
  insertValuesMock.mockReset();
  indexMemoryMock.mockResolvedValue({
    id: 'm-new',
    embeddedAt: new Date(),
    truncated: false,
    degraded: false,
  });
  insertReturningMock.mockResolvedValue([{ id: 'issue-new' }]);
});

describe('promotion defaults', () => {
  // cm:guard these are the fallbacks a project that sets `enabled` alone inherits, so changing one changes the rate on every opted-in project that never named a number
  it('PROMOTION_RETRIEVAL_MIN is 3', () => {
    expect(PROMOTION_RETRIEVAL_MIN).toBe(3);
  });

  it('PROMOTION_AGE_DAYS is 7', () => {
    expect(PROMOTION_AGE_DAYS).toBe(7);
  });

  it('PROMOTION_CANDIDATES_PER_RUN is 3', () => {
    expect(PROMOTION_CANDIDATES_PER_RUN).toBe(3);
  });
});

describe('resolveKnowledgePromotion', () => {
  it('reads absent config as disabled, carrying the default thresholds', async () => {
    selectResults.push([{ agentConfig: null }]);
    await expect(resolveKnowledgePromotion(PROJECT_ID)).resolves.toEqual({
      enabled: false,
      candidatesPerRun: 3,
      minRetrievals: 3,
    });
  });

  it('reads enabled with per-project overrides', async () => {
    selectResults.push([
      {
        agentConfig: {
          pipelineConfig: {
            knowledgePromotion: { enabled: true, candidatesPerRun: 1, minRetrievals: 6 },
          },
        },
      },
    ]);
    await expect(resolveKnowledgePromotion(PROJECT_ID)).resolves.toEqual({
      enabled: true,
      candidatesPerRun: 1,
      minRetrievals: 6,
    });
  });

  // cm:guard `enabled` is the ONLY truthiness accepted — a string or a 1 from a hand-rolled PATCH must read as off, because the on state costs runner capacity and a typo must never buy it
  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['absent', undefined],
  ])('does not enable on %s', async (_label, value) => {
    selectResults.push([
      { agentConfig: { pipelineConfig: { knowledgePromotion: { enabled: value } } } },
    ]);
    await expect(resolveKnowledgePromotion(PROJECT_ID)).resolves.toMatchObject({ enabled: false });
  });
});

describe('proposeKnowledgePromotions', () => {
  const CANDIDATE = {
    id: 'm-k-1',
    source: 'knowledge',
    sourceRef: 'consolidated:abc123',
    textContent: 'Always use rebase over merge for feature branches',
    metadata: {},
  };

  function queueConfig(cfg: Record<string, unknown> | null) {
    selectResults.push([
      { agentConfig: cfg ? { pipelineConfig: { knowledgePromotion: cfg } } : {} },
    ]);
  }

  function queuePromotion(opts: {
    config?: Record<string, unknown> | null;
    projectRow?: unknown[];
    candidates?: unknown[];
  }) {
    queueConfig(opts.config === undefined ? { enabled: true } : opts.config);
    selectResults.push(opts.projectRow ?? [{ createdBy: 'user-creator' }]);
    selectResults.push(opts.candidates ?? [CANDIDATE]);
  }

  // cm:guard the candidates are PRIMED here on purpose — a gate test whose query returns nothing passes whether or not the gate exists, which is the vacuous green this pair was written to rule out
  it('proposes nothing when the project never opted in, even with candidates waiting', async () => {
    queuePromotion({ config: null });

    await proposeKnowledgePromotions(PROJECT_ID);

    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('proposes on the same fixture once the project opts in', async () => {
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        source: 'knowledge',
        sourceRef: 'consolidated:abc123',
        metadata: expect.objectContaining({ promotionProposedAt: expect.any(String) }),
      }),
      undefined,
    );
  });

  // cm:guard `open` auto-triages into a pipeline run — that is the point (a `draft` had no owner and 63 of 71 were swept unworked), and it is why the opt-in above must hold
  it('files the proposal at open, not draft', async () => {
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'open',
        category: 'knowledge-promotion',
        priority: 'low',
        createdVia: 'schedule',
      }),
    );
  });

  it('names the config that produced it, so the reader can turn it off', async () => {
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    const values = insertValuesMock.mock.calls[0]?.[0] as { description: string };
    expect(values.description).toContain('pipelineConfig.knowledgePromotion.enabled');
    expect(values.description).not.toContain('"always"');
  });

  it('early-returns when no project creator found', async () => {
    queueConfig({ enabled: true });
    selectResults.push([]);

    await proposeKnowledgePromotions(PROJECT_ID);

    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('early-returns when no candidates meet the criteria', async () => {
    queuePromotion({ candidates: [] });

    await proposeKnowledgePromotions(PROJECT_ID);

    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('handles multiple candidates, stamping each with promotionProposedAt', async () => {
    queueConfig({ enabled: true });
    selectResults.push([{ createdBy: 'user-creator' }]);
    selectResults.push([
      {
        id: 'm-1',
        source: 'knowledge',
        sourceRef: 'ref-1',
        textContent: 'lesson one',
        metadata: {},
      },
      {
        id: 'm-2',
        source: 'decision',
        sourceRef: 'ref-2',
        textContent: 'lesson two',
        metadata: {},
      },
    ]);

    await proposeKnowledgePromotions(PROJECT_ID);

    expect(insertValuesMock).toHaveBeenCalledTimes(2);
    expect(indexMemoryMock).toHaveBeenCalledTimes(2);
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRef: 'ref-1',
        metadata: expect.objectContaining({ promotionProposedAt: expect.any(String) }),
      }),
      undefined,
    );
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRef: 'ref-2',
        metadata: expect.objectContaining({ promotionProposedAt: expect.any(String) }),
      }),
      undefined,
    );
  });

  it('skips stamp and logs a warning when insert returns no row', async () => {
    insertReturningMock.mockResolvedValueOnce([]);
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    // cm:guard no issue row means no stamp — stamping anyway would burn the memory's one proposal on a proposal that never reached anybody
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('never writes knowledge_entries (only indexMemory for stamp + db.insert for issues)', async () => {
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    // cm:guard the only write this may make to the memory store is the idempotency stamp on the SAME sourceRef — a call carrying a new slug would mean it minted a curated entry itself, which is the one thing the proposal step exists to not do
    const calls = indexMemoryMock.mock.calls.map(
      (c) => c[0] as { source?: string; sourceRef?: string },
    );
    for (const call of calls) {
      expect(call.sourceRef).toBe('consolidated:abc123');
    }
  });
});
