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
  NEAR_DUPLICATE_THRESHOLD: 0.85,
  indexMemory: (input: unknown, opts?: unknown) => indexMemoryMock(input, opts),
  indexMemoryBestEffort: (input: unknown) => indexMemoryBestEffortMock(input),
}));

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

const searchKnowledgeMock = vi.fn();
vi.mock('../knowledge/search.js', () => ({
  searchKnowledge: (...args: unknown[]) => searchKnowledgeMock(...args),
}));

const runMemoryFeedbackMock = vi.fn();
vi.mock('./feedback-service.js', () => ({
  runMemoryFeedback: (input: unknown) => runMemoryFeedbackMock(input),
}));

// cm:guard the stub is ORDER-sensitive, not shape-sensitive: each select() consumes the next queued result whether the chain ends at .limit() or is awaited at .where(). Adding a query without queueing a row for it steals the next test's row rather than failing where the gap is.
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
      insert: () => ({ values: () => ({ returning: insertReturningMock }) }),
    },
  };
});

const {
  runConsolidationForProject,
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
  searchKnowledgeMock.mockReset();
  runMemoryFeedbackMock.mockReset();
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
  archiveUpdateMock.mockResolvedValue([{ sourceRef: 'ref-m-1' }]);
  insertReturningMock.mockResolvedValue([{ id: 'issue-new' }]);
  embedMock.mockResolvedValue(new Array(8).fill(0.01));
  runMemoryFeedbackMock.mockResolvedValue({ found: true, action: 'archived' });
  searchKnowledgeMock.mockResolvedValue([]);
  searchMemoriesMock.mockResolvedValue([]);
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

const OBHOD = 'обход';

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
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'knowledge',
        sourceRef: expect.stringMatching(/^consolidated:[0-9a-f]{12}$/),
      }),
      undefined,
    );
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'note', sourceRef: 'n-1', text: 'merged cleaner note' }),
      undefined,
    );
    expect(indexMemoryBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'decision' }),
    );
  });

  it('creates nothing and updates nothing in a script the prompt never showed it', async () => {
    queueSignal();
    llmResponds({
      create: [
        { content: `deploy branch is master ${OBHOD}`, category: 'correction' },
        { content: 'deploy branch is master', category: 'correction' },
      ],
      update: [{ id: 'm-1', newContent: `merged cleaner note ${OBHOD}` }],
      archive: [],
      summary: 'one of each refused',
    });

    const result = await runConsolidationForProject(PROJECT_ID);

    expect(result).toMatchObject({ created: 1, updated: 0, refused: 2 });
    expect(indexMemoryMock).toHaveBeenCalledTimes(1);
    expect(indexMemoryMock.mock.calls[0]?.[0]).toMatchObject({
      text: 'deploy branch is master',
    });
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

describe('consolidation does not re-mint what is already recorded', () => {
  // cm:why the assertion is that indexMemory was NOT called — the old code ran the near-duplicate probe, threw the answer away, wrote anyway and counted it a create, so asserting on the count alone passes against the defect
  it('skips a create the CURATED knowledge store already covers, and names it', async () => {
    queueSignal();
    llmResponds({
      create: [
        { content: 'a green pnpm test may be a Turbo cache replay', category: 'convention' },
      ],
    });
    searchKnowledgeMock.mockResolvedValueOnce([
      { slug: 'pnpm-test-replays-another-worktrees-turbo-cache', score: 0.93 },
    ]);

    const result = await runConsolidationForProject(PROJECT_ID);

    expect(result.created).toBe(0);
    expect(indexMemoryMock).not.toHaveBeenCalled();
    const receipt = indexMemoryBestEffortMock.mock.calls.at(-1)?.[0];
    expect(receipt.metadata.skippedAsRecorded).toEqual([
      'knowledge_entries:pnpm-test-replays-another-worktrees-turbo-cache',
    ]);
    expect(receipt.text).toContain('skipped 1 already recorded');
  });

  it('skips a create an existing MEMORY row already covers', async () => {
    queueSignal();
    llmResponds({
      create: [{ content: 'some lesson already held in memory', category: 'convention' }],
    });
    searchKnowledgeMock.mockResolvedValueOnce([]);
    searchMemoriesMock.mockResolvedValueOnce([{ sourceRef: 'consolidated:deadbeef', score: 0.91 }]);

    const result = await runConsolidationForProject(PROJECT_ID);

    expect(result.created).toBe(0);
    expect(indexMemoryMock).not.toHaveBeenCalled();
  });

  it('still writes a create that neither store covers', async () => {
    queueSignal();
    llmResponds({
      create: [{ content: 'a genuinely new lesson nobody recorded', category: 'convention' }],
    });
    searchKnowledgeMock.mockResolvedValueOnce([{ slug: 'unrelated', score: 0.2 }]);
    searchMemoriesMock.mockResolvedValueOnce([{ sourceRef: 'other', score: 0.3 }]);

    const result = await runConsolidationForProject(PROJECT_ID);

    expect(result.created).toBe(1);
    expect(indexMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef: expect.stringMatching(/^consolidated:[0-9a-f]{12}$/) }),
      undefined,
    );
  });
});

describe('a receipt names what it touched, never only how much', () => {
  // cm:why these assert on the TEXT and the metadata refs, not the counts — a receipt that counts is what shipped for months, and a count identifies no row, so nothing it claims can be checked or undone by a later reader
  it('reconcile names the contradicted and stale-stamped refs', async () => {
    queueIssueLookup();
    queueIdempotency();
    searchMemoriesMock.mockResolvedValueOnce([memoryHit('m-1'), memoryHit('m-2')]);
    llmResponds({
      contradicted: [{ id: 'm-1', evidence: 'IA restructured into 3 pipelines' }],
      possiblyStale: [{ id: 'm-2' }],
    });
    updateSetMock.mockReturnValue(undefined);

    await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    const receipt = indexMemoryBestEffortMock.mock.calls.at(-1)?.[0];
    expect(receipt.text).toContain('contradicted: ref-m-1');
    expect(receipt.text).toContain('stale-stamped: ref-m-2');
    expect(receipt.metadata.contradictedRefs).toEqual(['ref-m-1']);
    expect(receipt.metadata.staleRefs).toEqual(['ref-m-2']);
  });

  it('consolidation names the archived refs and does not print its counts twice', async () => {
    queueSignal();
    llmResponds({ create: [], update: [], archive: ['m-1'] });

    await runConsolidationForProject(PROJECT_ID);

    const receipt = indexMemoryBestEffortMock.mock.calls.at(-1)?.[0];
    expect(receipt.text).toContain('archived: ref-m-1');
    expect(receipt.metadata.archivedRefs).toEqual(['ref-m-1']);
    expect(receipt.text.match(/created 0, updated 0, archived 1/g)).toHaveLength(1);
  });

  it('gives each consolidation run its own ref so a same-day rerun cannot replace the first', async () => {
    const refs: string[] = [];
    for (let i = 0; i < 2; i++) {
      queueSignal();
      llmResponds({ create: [], update: [], archive: ['m-1'] });
      await runConsolidationForProject(PROJECT_ID);
      refs.push(indexMemoryBestEffortMock.mock.calls.at(-1)?.[0].sourceRef);
    }
    expect(refs[0]).not.toBe(refs[1]);
    expect(refs[0]).toMatch(/^consolidation:\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  });
});

describe('reconcileForReleasedIssue', () => {
  it('skips when the issue is not found', async () => {
    selectResults.push([]);

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
    // cm:guard the archive path reuses `runMemoryFeedback` and must never grow a direct `db.update` for contradicted rows — a second writer of that column is how the two disagree about what archived means.
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(indexMemoryBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'decision', sourceRef: 'reconcile:ISS-708' }),
    );
  });

  it('archives nothing on evidence in a script the prompt never showed it', async () => {
    queueIssueLookup();
    queueIdempotency();
    searchMemoriesMock.mockResolvedValueOnce([memoryHit('m-1')]);
    llmResponds({
      contradicted: [{ id: 'm-1', evidence: `IA restructured into 3 pipelines ${OBHOD}` }],
      possiblyStale: [],
      unaffected: [],
    });

    const result = await reconcileForReleasedIssue(PROJECT_ID, ISSUE_ID);

    expect(result.contradicted).toBe(0);
    expect(result.refused).toBe(1);
    expect(runMemoryFeedbackMock).not.toHaveBeenCalled();
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
    expect(indexMemoryMock).not.toHaveBeenCalled();
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

  it('enqueues a reconcile job when a transition lands merged_at (leaving BASE_MERGE_STATE)', async () => {
    const { bus, emit } = fakeBus();
    registerMemoryReconcileTrigger(bus);

    emit({
      issueId: 'issue-1',
      projectId: PROJECT_ID,
      actor: { type: 'user', id: 'u-1' },
      from: 'awaiting_release',
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

  it('enqueues when leaving BASE_MERGE_STATE even without reaching closed', async () => {
    const { bus, emit } = fakeBus();
    registerMemoryReconcileTrigger(bus);

    emit({
      issueId: 'issue-2',
      projectId: PROJECT_ID,
      actor: { type: 'user', id: 'u-1' },
      from: 'awaiting_release',
      to: 'archived-elsewhere',
      reopenCount: 0,
    });
    await flush();

    expect(bossSendMock).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue for a non-merge-landing transition', async () => {
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
