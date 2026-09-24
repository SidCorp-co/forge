/**
 * ISS-103 — unit tests for `runs-rollup.ts`. These exercise the
 * status-precedence + duration-derivation logic against mocked SQL responses
 * so the route layer can trust the shape it returns.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SelectQueue = Array<unknown[] | unknown>;

const stepsQueue: SelectQueue = [];
const costQueue: SelectQueue = [];
const runRowQueue: SelectQueue = [];
const bulkCostQueue: SelectQueue = [];
const issueQueue: SelectQueue = [];
const livenessQueue: SelectQueue = [];
const attemptsQueue: SelectQueue = [];

let nextSelectKind: 'steps' | 'cost' | 'runRow' | 'bulkCost' = 'steps';

vi.mock('../issues/issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => null,
  heldIssuePrefixes: async () => [],
}));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (...args: unknown[]) => ({ _eq: args }),
  asc: (...args: unknown[]) => ({ _asc: args }),
  inArray: (...args: unknown[]) => ({ _inArray: args }),
  notInArray: (...args: unknown[]) => ({ _notInArray: args }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const obj = { _sql: strings.join('?'), values };
      return Object.assign(obj, { mapWith: () => obj });
    },
    { join: (parts: unknown[], sep: unknown) => ({ _join: parts, sep }) },
  ) as never,
}));

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
    failureReason: 'agent_sessions.failure_reason',
    failureDetail: 'agent_sessions.failure_detail',
    lastHeartbeatAt: 'agent_sessions.last_heartbeat_at',
  },
  jobStatuses: ['queued', 'dispatched', 'running', 'held', 'done', 'failed', 'cancelled'],
  terminalAgentSessionStatuses: [
    'completed',
    'failed',
    'completed_via_recovery',
    'cancelled_stale',
    'cancelled',
  ],
  jobs: {
    id: 'jobs.id',
    pipelineRunId: 'jobs.pipeline_run_id',
    type: 'jobs.type',
    status: 'jobs.status',
    attempts: 'jobs.attempts',
    retryOf: 'jobs.retry_of',
    deviceId: 'jobs.device_id',
    failureReason: 'jobs.failure_reason',
    failureKind: 'jobs.failure_kind',
    failureAction: 'jobs.failure_action',
    agentSessionId: 'jobs.agent_session_id',
    queuedAt: 'jobs.queued_at',
    dispatchedAt: 'jobs.dispatched_at',
    finishedAt: 'jobs.finished_at',
    payload: 'jobs.payload',
  },
  devices: { id: 'devices.id', name: 'devices.name' },
  pipelineRuns: { id: 'pipeline_runs.id' },
  issues: {
    id: 'issues.id',
    issSeq: 'issues.iss_seq',
    projectId: 'issues.project_id',
    title: 'issues.title',
  },
  projects: { id: 'projects.id', issuePrefix: 'projects.issue_prefix' },
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
    execute: () => Promise.resolve(livenessQueue.shift() ?? []),
    select: () => ({
      from: (table: unknown) => {
        const tableKey = typeof table === 'object' && table !== null ? Object.values(table)[0] : '';
        const isAgentSessions = String(tableKey).startsWith('agent_sessions');
        const isUsageRecords = String(tableKey).startsWith('usage_records');
        const isPipelineRuns = String(tableKey).startsWith('pipeline_runs');
        const isIssues = String(tableKey).startsWith('issues');
        const isAttempts = String(tableKey).startsWith('jobs.');

        const result = isAgentSessions
          ? stepsQueue.shift()
          : isPipelineRuns
            ? runRowQueue.shift()
            : isIssues
              ? issueQueue.shift()
              : isAttempts
                ? attemptsQueue.shift()
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
  livenessQueue.length = 0;
  attemptsQueue.length = 0;
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
  // What a run that is not a release carries on the two ISS-1120 columns.
  releaseVersion: null,
  releaseReleasedAt: null,
  createdAt: new Date('2026-05-12T00:00:00.000Z'),
  updatedAt: new Date('2026-05-12T00:00:00.000Z'),
};

/** The gate both languages assert, read where the fixture holds it. */
const GATE_AT_OPEN = (
  JSON.parse(
    readFileSync(new URL('../devices/gate-report.fixture.json', import.meta.url), 'utf8'),
  ) as { degraded: Record<string, unknown> }
).degraded;

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

  it('ISS-789: reports the run live-job count, not the rowToListItem zero default', async () => {
    runRowQueue.push([runRow]);
    stepsQueue.push([]);
    costQueue.push([]);
    livenessQueue.push([{ run_id: RUN_ID, live_jobs: 2, last_beat: null }]);

    const result = await loadPipelineRunSummary(RUN_ID);
    expect(result?.liveJobs).toBe(2);
  });

  it('ISS-998: carries the run session heartbeat, not the rowToListItem null default', async () => {
    const beat = new Date('2026-09-13T11:59:00.000Z');
    runRowQueue.push([runRow]);
    stepsQueue.push([]);
    costQueue.push([]);
    livenessQueue.push([{ run_id: RUN_ID, live_jobs: 0, last_beat: beat }]);

    const result = await loadPipelineRunSummary(RUN_ID);
    expect(result?.lastSessionBeatAt).toBe('2026-09-13T11:59:00.000Z');
  });

  it('ISS-998: a run with no live session reads null rather than a stale stamp', async () => {
    runRowQueue.push([runRow]);
    stepsQueue.push([]);
    costQueue.push([]);
    livenessQueue.push([{ run_id: RUN_ID, live_jobs: 0, last_beat: null }]);

    const result = await loadPipelineRunSummary(RUN_ID);
    expect(result?.lastSessionBeatAt).toBeNull();
  });

  // ISS-1192 criterion 18: without a reader here, "was the gate deciding while
  // this ran" is answerable only by psql against production.
  it('ISS-1192: returns the gate condition the run opened under', async () => {
    runRowQueue.push([{ ...runRow, metadata: { gateAtOpen: GATE_AT_OPEN } }]);
    stepsQueue.push([]);
    costQueue.push([]);
    const seen = (await loadPipelineRunSummary(RUN_ID))?.gateAtOpen;
    expect(seen).toEqual({ read: 'ok', condition: GATE_AT_OPEN });
  });

  it('ISS-1192: a run opened by a box that sent no condition reports none', async () => {
    runRowQueue.push([{ ...runRow, metadata: { runIssues: ['ISS-1'] } }]);
    stepsQueue.push([]);
    costQueue.push([]);
    expect((await loadPipelineRunSummary(RUN_ID))?.gateAtOpen).toBeNull();
  });

  it('ISS-789: a run with no live jobs reads 0, so a dead run is distinguishable from a live one', async () => {
    runRowQueue.push([runRow]);
    stepsQueue.push([]);
    costQueue.push([]);
    livenessQueue.push([]);

    const result = await loadPipelineRunSummary(RUN_ID);
    expect(result?.status).toBe('running');
    expect(result?.liveJobs).toBe(0);
  });
});

describe('listItemsFromRows', () => {
  it('returns [] when given no rows (and does not query the db)', async () => {
    const items = await listItemsFromRows([]);
    expect(items).toEqual([]);
  });

  it('falls back to zero cost for runs missing from the cost map', async () => {
    nextSelectKind = 'bulkCost';
    bulkCostQueue.push([]);

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

  it('ISS-789: the list surface keeps reporting the batched live-job count', async () => {
    nextSelectKind = 'bulkCost';
    bulkCostQueue.push([]);
    livenessQueue.push([
      { run_id: RUN_ID, live_jobs: 3, last_beat: new Date('2026-09-13T11:58:00.000Z') },
    ]);

    const items = await listItemsFromRows([runRow]);
    expect(items[0]!.liveJobs).toBe(3);
    expect(items.map((i) => i.lastSessionBeatAt)).toEqual(['2026-09-13T11:58:00.000Z']);
  });
});

describe('ISS-885: the attempt timeline carries the classified cause', () => {
  it('joins the session cause + detail onto the attempt, not just the job free text', async () => {
    runRowQueue.push([runRow]);
    stepsQueue.push([]);
    costQueue.push([]);
    livenessQueue.push([]);
    attemptsQueue.push([
      {
        jobId: 'job-1',
        jobType: 'code',
        status: 'failed',
        attempts: 1,
        retryOf: null,
        deviceId: 'dev-1',
        deviceName: 'ubuntu5',
        failureReason: 'usage/session limit -> cross-device failover',
        failureKind: 'transient-cc',
        failureAction: 'failover',
        failureCause: 'provider_spend_cap',
        failureDetail: 'org monthly cap reached',
        queuedAt: new Date('2026-05-12T00:00:00.000Z'),
        dispatchedAt: null,
        finishedAt: new Date('2026-05-12T00:01:00.000Z'),
        payload: {},
      },
    ]);

    const summary = await loadPipelineRunSummary(RUN_ID);

    expect(summary?.attempts[0]?.failureCause).toBe('provider_spend_cap');
    expect(summary?.attempts[0]?.failureDetail).toBe('org monthly cap reached');
    expect(summary?.attempts[0]?.failureKind).toBe('transient-cc');
    expect(summary?.attempts[0]?.failureAction).toBe('failover');
  });

  it('leaves the cause null when the attempt never reached a session, keeping the row', async () => {
    runRowQueue.push([runRow]);
    stepsQueue.push([]);
    costQueue.push([]);
    livenessQueue.push([]);
    attemptsQueue.push([
      {
        jobId: 'job-2',
        jobType: 'code',
        status: 'failed',
        attempts: 1,
        retryOf: null,
        deviceId: null,
        deviceName: null,
        failureReason: null,
        failureKind: null,
        failureAction: null,
        failureCause: null,
        failureDetail: null,
        queuedAt: new Date('2026-05-12T00:00:00.000Z'),
        dispatchedAt: null,
        finishedAt: null,
        payload: {},
      },
    ]);

    const summary = await loadPipelineRunSummary(RUN_ID);

    expect(summary?.attempts).toHaveLength(1);
    expect(summary?.attempts[0]?.failureCause).toBeNull();
  });
});
