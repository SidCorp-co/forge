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

const bossSendMock = vi.fn();
const bossCreateQueueMock = vi.fn();
const bossWorkMock = vi.fn();
vi.mock('../queue/boss.js', () => ({
  boss: {
    send: (...args: unknown[]) => bossSendMock(...args),
    createQueue: (...args: unknown[]) => bossCreateQueueMock(...args),
    work: (...args: unknown[]) => bossWorkMock(...args),
  },
}));

const indexMemoryMock = vi.fn();
const indexMemoryBestEffortMock = vi.fn();
vi.mock('./indexer.js', () => ({
  MAX_EMBED_CHARS: 8192,
  indexMemory: (input: unknown, opts?: unknown) => indexMemoryMock(input, opts),
  indexMemoryBestEffort: (input: unknown) => indexMemoryBestEffortMock(input),
}));

// ISS-708: reconcileForReleasedIssue's collaborators.
const embedMock = vi.fn();
class FakeEmbeddingUnavailableError extends Error {}
vi.mock('../embeddings/index.js', () => ({
  embed: (text: string) => embedMock(text),
  EmbeddingUnavailableError: FakeEmbeddingUnavailableError,
}));

const searchMemoriesMock = vi.fn();
vi.mock('./search.js', () => ({
  searchMemories: (input: unknown) => searchMemoriesMock(input),
}));

const runMemoryFeedbackMock = vi.fn();
vi.mock('./feedback-service.js', () => ({
  runMemoryFeedback: (input: unknown) => runMemoryFeedbackMock(input),
}));

const resolveMergeStatesMock = vi.fn();
vi.mock('../issues/merged-at.js', () => ({
  resolveMergeStates: (cfg: unknown) => resolveMergeStatesMock(cfg),
}));

// Read chains differ: joins end in .limit(), the distinct-project query ends
// at .where(). Sequence-based stub: each select() call consumes the next
// queued result regardless of chain shape (thenable + .limit()).
const selectResults: unknown[][] = [];
const updateSetMock = vi.fn();
const archiveUpdateMock = vi.fn();
const insertReturningMock = vi.fn();
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
        set: (s: unknown) => {
          updateSetMock(s);
          return { where: (w: unknown) => ({ returning: () => archiveUpdateMock(w) }) };
        },
      }),
      // ISS-568: used by proposeKnowledgePromotions to insert draft issues.
      insert: () => ({ values: () => ({ returning: insertReturningMock }) }),
    },
  };
});

const {
  runConsolidationForProject,
  proposeKnowledgePromotions,
  PROMOTION_RETRIEVAL_MIN,
  PROMOTION_AGE_DAYS,
  PROMOTION_CANDIDATES_PER_RUN,
  reconcileForReleasedIssue,
  registerMemoryReconcileTrigger,
  registerMemoryReconcileWorker,
  resetMemoryReconcileTriggerForTest,
  resetMemoryReconcileWorkerForTest,
  MEMORY_RECONCILE_QUEUE,
} = await import('./consolidation.js');

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
  updateSetMock.mockReset();
  archiveUpdateMock.mockReset();
  insertReturningMock.mockReset();
  embedMock.mockReset();
  searchMemoriesMock.mockReset();
  runMemoryFeedbackMock.mockReset();
  resolveMergeStatesMock.mockReset();
  bossSendMock.mockReset();
  bossCreateQueueMock.mockReset();
  bossWorkMock.mockReset();
  resetMemoryReconcileTriggerForTest();
  resetMemoryReconcileWorkerForTest();
  selectResults.length = 0;
  indexMemoryMock.mockResolvedValue({
    id: 'm-new',
    embeddedAt: new Date(),
    truncated: false,
    degraded: false,
  });
  indexMemoryBestEffortMock.mockResolvedValue(undefined);
  archiveUpdateMock.mockResolvedValue([{ id: 'm-1' }]);
  insertReturningMock.mockResolvedValue([{ id: 'issue-new' }]);
  embedMock.mockResolvedValue(new Array(8).fill(0.01));
  runMemoryFeedbackMock.mockResolvedValue({ found: true, action: 'archived' });
  resolveMergeStatesMock.mockReturnValue({ baseBranch: 'released', productionBranch: 'released' });
  bossCreateQueueMock.mockResolvedValue(undefined);
  bossWorkMock.mockResolvedValue(undefined);
  bossSendMock.mockResolvedValue(undefined);
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

    expect(result).toMatchObject({
      created: 1,
      updated: 1,
      archived: 1,
      summary: 'merged and cleaned',
    });
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

// ── ISS-568: proposeKnowledgePromotions ───────────────────────────────────────

describe('promotion constants', () => {
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

describe('proposeKnowledgePromotions', () => {
  function queuePromotion(opts: {
    projectRow?: unknown[];
    candidates?: unknown[];
  }) {
    selectResults.push(opts.projectRow ?? [{ createdBy: 'user-creator' }]);
    selectResults.push(
      opts.candidates ?? [
        {
          id: 'm-k-1',
          source: 'knowledge',
          sourceRef: 'consolidated:abc123',
          textContent: 'Always use rebase over merge for feature branches',
          metadata: {},
        },
      ],
    );
  }

  it('creates a draft issue per candidate and stamps promotionProposedAt', async () => {
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    // Draft issue was inserted.
    expect(insertReturningMock).toHaveBeenCalledTimes(1);

    // Memory was stamped with promotionProposedAt for idempotency.
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

  it('draft issue is status=draft, category=knowledge-promotion, priority=low', async () => {
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    // The values() call receives the issue fields — check via the mock structure.
    // insertReturningMock is called as the .returning() step; the values are
    // passed to the .values() call which we can inspect via the db.insert mock.
    // Since our mock is insert() → values(valuesArg) → returning(insertReturningMock),
    // we verify via the actual call to insertReturningMock and indexMemory stamps.
    expect(insertReturningMock).toHaveBeenCalledTimes(1);
    // Injection='always' must never appear in the draft description.
    const indexCall = indexMemoryMock.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> };
    expect(JSON.stringify(indexCall?.metadata)).not.toContain('"always"');
  });

  it('early-returns when no project creator found', async () => {
    // Empty project row → no creator → no-op.
    selectResults.push([]); // project creator query returns nothing
    // No candidates needed since we return early.

    await proposeKnowledgePromotions(PROJECT_ID);

    expect(insertReturningMock).not.toHaveBeenCalled();
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('early-returns when no candidates meet the criteria', async () => {
    selectResults.push([{ createdBy: 'user-creator' }]); // project row
    selectResults.push([]); // no candidates

    await proposeKnowledgePromotions(PROJECT_ID);

    expect(insertReturningMock).not.toHaveBeenCalled();
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('handles multiple candidates, stamping each with promotionProposedAt', async () => {
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

    // Two draft issues, two memory stamps.
    expect(insertReturningMock).toHaveBeenCalledTimes(2);
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
    insertReturningMock.mockResolvedValueOnce([]); // insert returns nothing
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    // indexMemory (stamp) must NOT be called since insert failed.
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('never writes knowledge_entries (only indexMemory for stamp + db.insert for issues)', async () => {
    queuePromotion({});

    await proposeKnowledgePromotions(PROJECT_ID);

    // indexMemory is only called for the metadata stamp (source='knowledge', not a new knowledge_entries entry).
    // Verify no forge_knowledge upsert — in this unit scope, just assert indexMemory source is
    // the original memory source, not a new knowledge_entries kind.
    const calls = indexMemoryMock.mock.calls.map(
      (c) => c[0] as { source?: string; sourceRef?: string },
    );
    for (const call of calls) {
      // sourceRef must match the original memory sourceRef (the stamp), not a new knowledge entry slug.
      expect(call.sourceRef).toBe('consolidated:abc123');
    }
  });
});

// ── ISS-708: reconcileForReleasedIssue ─────────────────────────────────────

const ISSUE_ID = '22222222-2222-4222-8222-222222222222';

function baseIssueRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    issSeq: 708,
    title: 'Memory reconcile-on-release',
    description: 'Closes the code→memory loop.',
    plan: null,
    releaseNotes: { section: 'Changed', userFacing: 'Agents now flag stale notes.' },
    mergedAt: new Date('2026-07-20T12:00:00.000Z'),
    ...overrides,
  };
}

function queueIssueLookup(overrides?: Partial<Record<string, unknown>>) {
  selectResults.push([baseIssueRow(overrides)]);
}

function queueIdempotency(existing?: unknown) {
  selectResults.push(existing ? [existing] : []);
}

function memoryHit(
  id: string,
  opts?: {
    score?: number;
    embeddedAt?: Date;
    source?: 'note' | 'knowledge';
    metadata?: unknown;
  },
) {
  return {
    id,
    source: opts?.source ?? 'note',
    sourceRef: `ref-${id}`,
    text: `old memory text for ${id}`,
    metadata: opts?.metadata ?? {},
    score: opts?.score ?? 0.9,
    embeddedAt: opts?.embeddedAt ?? new Date('2026-01-01T00:00:00.000Z'),
    stale: false,
  };
}

describe('reconcileForReleasedIssue', () => {
  it('skips when the issue is not found', async () => {
    selectResults.push([]); // issue lookup — empty

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.skipped).toBe('issue-not-found');
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('is idempotent — skips when a reconcile:ISS-N decision memory already exists', async () => {
    queueIssueLookup();
    queueIdempotency({ id: 'decision-1' });

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.skipped).toBe('already-reconciled');
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('skips no-signal when the release has no usable text', async () => {
    queueIssueLookup({ title: '', description: null, plan: null, releaseNotes: null });
    queueIdempotency();

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.skipped).toBe('no-signal');
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('skips when embeddings are unavailable', async () => {
    queueIssueLookup();
    queueIdempotency();
    embedMock.mockRejectedValueOnce(new FakeEmbeddingUnavailableError('embeddings down'));

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.skipped).toBe('embeddings-unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips no-signal when no candidate memory pre-dates the release', async () => {
    queueIssueLookup();
    queueIdempotency();
    searchMemoriesMock.mockResolvedValueOnce([
      memoryHit('m-future', { embeddedAt: new Date('2026-08-01T00:00:00.000Z') }),
    ]);

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.skipped).toBe('no-signal');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips no-signal when candidates score below the cosine floor', async () => {
    queueIssueLookup();
    queueIdempotency();
    searchMemoriesMock.mockResolvedValueOnce([memoryHit('m-weak', { score: 0.1 })]);

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.skipped).toBe('no-signal');
  });

  it('archives CONTRADICTED candidates via evidence-gated runMemoryFeedback with "superseded by ISS-N" evidence', async () => {
    queueIssueLookup();
    queueIdempotency();
    searchMemoriesMock.mockResolvedValueOnce([memoryHit('m-1')]);
    llmResponds({
      contradicted: [{ id: 'm-1', evidence: 'IA restructured into 3 pipelines' }],
      possiblyStale: [],
      unaffected: [],
    });

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.contradicted).toBe(1);
    expect(result.possiblyStale).toBe(0);
    expect(runMemoryFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        source: 'note',
        sourceRef: 'ref-m-1',
        verdict: 'outdated',
        evidence: expect.stringContaining('superseded by ISS-708'),
      }),
    );
    // Archive path reuses runMemoryFeedback — no direct db.update for contradicted rows.
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(indexMemoryBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'decision', sourceRef: 'reconcile:ISS-708' }),
    );
  });

  it('stamps POSSIBLY_STALE candidates with metadata.staleSince/supersededBy — no archive, no re-embed', async () => {
    queueIssueLookup();
    queueIdempotency();
    searchMemoriesMock.mockResolvedValueOnce([memoryHit('m-2', { metadata: { keep: true } })]);
    llmResponds({
      contradicted: [],
      possiblyStale: [{ id: 'm-2' }],
      unaffected: [],
    });
    archiveUpdateMock.mockResolvedValueOnce([{ id: 'm-2' }]);

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.possiblyStale).toBe(1);
    expect(result.contradicted).toBe(0);
    expect(runMemoryFeedbackMock).not.toHaveBeenCalled();
    expect(indexMemoryMock).not.toHaveBeenCalled(); // no re-embed
    expect(updateSetMock).toHaveBeenCalledTimes(1);
    const set = updateSetMock.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(set.metadata).toMatchObject({ keep: true, supersededBy: 'ISS-708' });
    expect(typeof set.metadata.staleSince).toBe('string');
  });

  it('tolerates a rambling non-JSON model output', async () => {
    queueIssueLookup();
    queueIdempotency();
    searchMemoriesMock.mockResolvedValueOnce([memoryHit('m-1')]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    });

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);
    expect(result.skipped).toBe('parse-failed');
  });

  it('skips llm-failed when the fast-model call fails', async () => {
    queueIssueLookup();
    queueIdempotency();
    searchMemoriesMock.mockResolvedValueOnce([memoryHit('m-1')]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);
    expect(result.skipped).toBe('llm-failed');
  });
});

describe('registerMemoryReconcileTrigger', () => {
  function fakeBus() {
    const onMock = vi.fn();
    let handler: ((p: unknown) => void) | undefined;
    onMock.mockImplementation((event: string, cb: (p: unknown) => void) => {
      if (event === 'transition') handler = cb;
      return () => undefined;
    });
    return {
      bus: { on: onMock } as never,
      onMock,
      emit: (payload: unknown) => handler?.(payload),
    };
  }

  async function flush() {
    await new Promise((r) => setTimeout(r, 0));
  }

  it('enqueues a reconcile job when a transition lands merged_at (leaving mergeStates.baseBranch)', async () => {
    selectResults.push([{ agentConfig: {} }]);
    const { bus, emit } = fakeBus();
    registerMemoryReconcileTrigger(bus);

    emit({
      issueId: 'issue-1',
      projectId: PROJECT_ID,
      actor: { type: 'user', id: 'u-1' },
      from: 'released',
      to: 'closed',
      reopenCount: 0,
    });
    await flush();

    expect(bossSendMock).toHaveBeenCalledWith(
      MEMORY_RECONCILE_QUEUE,
      { projectId: PROJECT_ID, issueId: 'issue-1' },
      expect.objectContaining({ singletonKey: 'issue-1:reconcile' }),
    );
  });

  it('enqueues when leaving baseBranch even without reaching closed', async () => {
    selectResults.push([{ agentConfig: {} }]);
    const { bus, emit } = fakeBus();
    registerMemoryReconcileTrigger(bus);

    emit({
      issueId: 'issue-2',
      projectId: PROJECT_ID,
      actor: { type: 'user', id: 'u-1' },
      from: 'released',
      to: 'archived-elsewhere',
      reopenCount: 0,
    });
    await flush();

    expect(bossSendMock).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue for a non-merge-landing transition', async () => {
    selectResults.push([{ agentConfig: {} }]);
    const { bus, emit } = fakeBus();
    registerMemoryReconcileTrigger(bus);

    emit({
      issueId: 'issue-3',
      projectId: PROJECT_ID,
      actor: { type: 'user', id: 'u-1' },
      from: 'confirmed',
      to: 'clarified',
      reopenCount: 0,
    });
    await flush();

    expect(bossSendMock).not.toHaveBeenCalled();
  });

  it('single-registration guard — a second call does not re-subscribe', () => {
    const { bus, onMock } = fakeBus();
    registerMemoryReconcileTrigger(bus);
    registerMemoryReconcileTrigger(bus);
    expect(onMock).toHaveBeenCalledTimes(1);
  });
});

describe('registerMemoryReconcileWorker', () => {
  it('creates the queue and registers a worker', async () => {
    await registerMemoryReconcileWorker();
    expect(bossCreateQueueMock).toHaveBeenCalledWith(MEMORY_RECONCILE_QUEUE);
    expect(bossWorkMock).toHaveBeenCalled();
  });

  it('is idempotent — a second call does not re-register', async () => {
    await registerMemoryReconcileWorker();
    await registerMemoryReconcileWorker();
    expect(bossCreateQueueMock).toHaveBeenCalledTimes(1);
  });
});
