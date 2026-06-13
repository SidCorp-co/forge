/**
 * ISS-103 — unit tests for `runs-rollup.ts`. These exercise the
 * status-precedence + duration-derivation logic against mocked SQL responses
 * so the route layer can trust the shape it returns.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type SelectQueue = Array<unknown[] | unknown>;

const stepsQueue: SelectQueue = [];
const costQueue: SelectQueue = [];
const runRowQueue: SelectQueue = [];
const bulkCostQueue: SelectQueue = [];
const issueQueue: SelectQueue = [];

let nextSelectKind: 'steps' | 'cost' | 'runRow' | 'bulkCost' = 'steps';

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  asc: (...args: unknown[]) => ({ _asc: args }),
  inArray: (...args: unknown[]) => ({ _inArray: args }),
  sql: ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const obj = { _sql: strings.join('?'), values };
    return Object.assign(obj, { mapWith: () => obj });
  }) as never,
}));

// ISS-411 — runs-rollup now imports the pure retry-state helpers; mock them so
// the suite does not transitively pull in the dispatch/queue graph (env-gated).
vi.mock('../jobs/retry.js', () => ({
  RETRY_MAX_ROUNDS: 10,
  readAutoRetryPayload: (payload: unknown) => {
    const raw =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)._autoRetry
        : null;
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      round: typeof r.round === 'number' ? r.round : 1,
      target: typeof r.target === 'string' ? r.target : null,
      tries: typeof r.tries === 'number' ? r.tries : 0,
      done: Array.isArray(r.done) ? r.done : [],
    };
  },
}));

vi.mock('../db/schema.js', () => ({
  agentSessions: {
    id: 'agent_sessions.id',
    metadata: 'agent_sessions.metadata',
    pipelineRunId: 'agent_sessions.pipeline_run_id',
    startedAt: 'agent_sessions.started_at',
    dispatchedAt: 'agent_sessions.dispatched_at',
    createdAt: 'agent_sessions.created_at',
    updatedAt: 'agent_sessions.updated_at',
    status: 'agent_sessions.status',
  },
  jobs: {
    id: 'jobs.id',
    pipelineRunId: 'jobs.pipeline_run_id',
    type: 'jobs.type',
    status: 'jobs.status',
    attempts: 'jobs.attempts',
    retryOf: 'jobs.retry_of',
    deviceId: 'jobs.device_id',
    failureReason: 'jobs.failure_reason',
    queuedAt: 'jobs.queued_at',
    dispatchedAt: 'jobs.dispatched_at',
    finishedAt: 'jobs.finished_at',
    payload: 'jobs.payload',
  },
  devices: { id: 'devices.id', name: 'devices.name' },
  pipelineRuns: { id: 'pipeline_runs.id' },
  issues: { id: 'issues.id', issSeq: 'issues.iss_seq', title: 'issues.title' },
  usageRecords: {
    id: 'usage_records.id',
    estimatedCost: 'usage_records.estimated_cost',
    inputTokens: 'usage_records.input_tokens',
    outputTokens: 'usage_records.output_tokens',
    cacheReadTokens: 'usage_records.cache_read_tokens',
    cacheCreationTokens: 'usage_records.cache_creation_tokens',
    requestCount: 'usage_records.request_count',
    sessionId: 'usage_records.session_id',
  },
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const tableKey = typeof table === 'object' && table !== null ? Object.values(table)[0] : '';
        const isAgentSessions = String(tableKey).startsWith('agent_sessions');
        const isUsageRecords = String(tableKey).startsWith('usage_records');
        const isPipelineRuns = String(tableKey).startsWith('pipeline_runs');
        const isIssues = String(tableKey).startsWith('issues');

        const result = isAgentSessions
          ? stepsQueue.shift()
          : isPipelineRuns
            ? runRowQueue.shift()
            : isIssues
              ? issueQueue.shift()
              : isUsageRecords
                ? nextSelectKind === 'bulkCost'
                  ? bulkCostQueue.shift()
                  : costQueue.shift()
                : [];

        return makeChain(Promise.resolve(result ?? []));
      },
    }),
  },
}));

function makeChain(eventual: Promise<unknown>): Record<string, unknown> {
  const chain = {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => eventual,
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      eventual.then(onFulfilled, onRejected),
  } as Record<string, unknown>;
  return chain;
}

const { loadPipelineRunSummary, listItemsFromRows } = await import('./runs-rollup.js');

beforeEach(() => {
  stepsQueue.length = 0;
  costQueue.length = 0;
  runRowQueue.length = 0;
  bulkCostQueue.length = 0;
  issueQueue.length = 0;
  nextSelectKind = 'steps';
});

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESS_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESS_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ISSUE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const runRow = {
  id: RUN_ID,
  projectId: PROJECT_ID,
  issueId: null,
  kind: 'issue' as const,
  status: 'running' as const,
  currentStep: 'code',
  startedAt: new Date('2026-05-12T00:00:00.000Z'),
  finishedAt: null,
  metadata: {},
  createdAt: new Date('2026-05-12T00:00:00.000Z'),
  updatedAt: new Date('2026-05-12T00:00:00.000Z'),
};

describe('loadPipelineRunSummary', () => {
  it('returns null when the run is missing', async () => {
    runRowQueue.push([]);
    const result = await loadPipelineRunSummary(RUN_ID);
    expect(result).toBeNull();
  });

  it('precedence: running session beats failed beats completed', async () => {
    runRowQueue.push([runRow]);
    stepsQueue.push([
      {
        jobType: 'code',
        latestId: SESS_A,
        startedAt: new Date('2026-05-12T00:01:00.000Z'),
        finishedAt: new Date('2026-05-12T00:02:00.000Z'),
        hasRunning: 1,
        hasFailed: 1,
        hasCompleted: 1,
        hasOpen: 0,
      },
    ]);
    costQueue.push([
      {
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requests: 0,
        sampleCount: 0,
      },
    ]);

    const result = await loadPipelineRunSummary(RUN_ID);
    expect(result?.steps).toHaveLength(1);
    const step = result!.steps[0]!;
    expect(step.status).toBe('running');
    // running is not terminal → no finishedAt + no durationMs
    expect(step.finishedAt).toBeNull();
    expect(step.durationMs).toBeNull();
    expect(step.agentSessionId).toBe(SESS_A);
  });

  it('terminal step computes durationMs from startedAt → finishedAt', async () => {
    runRowQueue.push([runRow]);
    stepsQueue.push([
      {
        jobType: 'review',
        latestId: SESS_B,
        startedAt: new Date('2026-05-12T00:00:00.000Z'),
        finishedAt: new Date('2026-05-12T00:00:05.000Z'),
        hasRunning: 0,
        hasFailed: 0,
        hasCompleted: 1,
        hasOpen: 0,
      },
    ]);
    costQueue.push([
      {
        estimatedCost: 0.5,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requests: 2,
        sampleCount: 1,
      },
    ]);

    const result = await loadPipelineRunSummary(RUN_ID);
    const step = result!.steps[0]!;
    expect(step.status).toBe('completed');
    expect(step.finishedAt).toBe('2026-05-12T00:00:05.000Z');
    expect(step.durationMs).toBe(5000);
    expect(result?.cost.estimatedCost).toBe(0.5);
    expect(result?.cost.sampleCount).toBe(1);
  });

  it('empty run → steps:[] and cost.sampleCount=0', async () => {
    runRowQueue.push([runRow]);
    stepsQueue.push([]);
    costQueue.push([
      {
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requests: 0,
        sampleCount: 0,
      },
    ]);

    const result = await loadPipelineRunSummary(RUN_ID);
    expect(result?.steps).toEqual([]);
    expect(result?.cost.sampleCount).toBe(0);
  });
});

describe('listItemsFromRows', () => {
  it('returns [] when given no rows (and does not query the db)', async () => {
    const items = await listItemsFromRows([]);
    expect(items).toEqual([]);
  });

  it('falls back to zero cost for runs missing from the cost map', async () => {
    nextSelectKind = 'bulkCost';
    bulkCostQueue.push([]); // no usage rows

    const items = await listItemsFromRows([runRow]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.cost.estimatedCost).toBe(0);
    expect(item.cost.sampleCount).toBe(0);
    expect(item.id).toBe(RUN_ID);
    expect(item.startedAt).toBe('2026-05-12T00:00:00.000Z');
  });

  it('no issueId → issueRef/issueTitle null (and does not query issues)', async () => {
    nextSelectKind = 'bulkCost';
    bulkCostQueue.push([]);
    const items = await listItemsFromRows([runRow]);
    expect(items[0]!.issueRef).toBeNull();
    expect(items[0]!.issueTitle).toBeNull();
  });

  it('ISS-460: maps cost (via agent_sessions rollup) and resolves issueRef/issueTitle', async () => {
    nextSelectKind = 'bulkCost';
    // loadCostByRunIds maps rows keyed on runId (now sourced from agent_sessions).
    bulkCostQueue.push([
      {
        runId: RUN_ID,
        estimatedCost: 0.42,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requests: 1,
        sampleCount: 3,
      },
    ]);
    issueQueue.push([{ id: ISSUE_ID, issSeq: 460, title: 'Live run data' }]);

    const items = await listItemsFromRows([{ ...runRow, issueId: ISSUE_ID }]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.cost.estimatedCost).toBe(0.42);
    expect(item.cost.sampleCount).toBe(3);
    expect(item.issueRef).toBe('ISS-460');
    expect(item.issueTitle).toBe('Live run data');
  });
});
