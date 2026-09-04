/**
 * ISS-903 — `pipelineHealth.queuedStep`: the identity of the step a queued job
 * represents, which is what the issue page needs to say "Agent queued · <step>"
 * for a job that has no `agent_sessions` row yet.
 *
 * The incident this covers is a DEFERRED RETRY, not a first dispatch: the job
 * is `queued` with `agentSessionId: null` behind an empty runner pool, so every
 * session-derived surface reports nothing at all.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    DEVICE_TOKEN_PEPPER: 'test-pepper-32-chars-long-abcdefghij',
    DATABASE_URL: 'postgres://test',
    NODE_ENV: 'test',
  },
}));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(), execute: vi.fn() },
}));

const { classifyPipelineHealthForIssue, safeHydratePipelineHealthForIssues } = await import(
  './pipeline-health.js'
);
type ClassifyInput = import('./pipeline-health.js').ClassifyInput;

const QUEUED_AT = new Date('2026-09-03T14:43:00.000Z');
const NOW = new Date('2026-09-03T17:22:00.000Z');

function baseInput(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    issue: { id: 'iss-903', status: 'in_progress', mergedAt: null, waitingKind: null },
    sessions: [],
    jobs: [],
    runnerInFlight: new Map(),
    runnerPool: { total: 1, withCapacity: 1 },
    lastTickAt: null,
    now: NOW,
    ...over,
  };
}

function queuedJob(over: Record<string, unknown> = {}) {
  return {
    id: 'a872c0b8',
    type: 'drive',
    status: 'queued',
    queuedAt: QUEUED_AT,
    runnerId: null,
    agentSessionId: null,
    pipelineRunStatus: 'running',
    stageStatus: 'open',
    retryAfterAt: null,
    ...over,
  } as ClassifyInput['jobs'][number];
}

describe('pipelineHealth.queuedStep', () => {
  it('names the queued step for the incident shape: no session, empty runner pool', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [queuedJob()], runnerPool: { total: 0, withCapacity: 0 } }),
    );
    expect(out.activeSession).toBeUndefined();
    expect(out.waitingOn?.reason).toBe('runner_stale');
    expect(out.queuedStep).toEqual({
      jobId: 'a872c0b8',
      jobType: 'drive',
      stageStatus: 'open',
      queuedAt: QUEUED_AT.toISOString(),
      retryAfterAt: null,
    });
  });

  it('names the queued step with NO waitingOn when the step is merely awaiting its turn', () => {
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [queuedJob()] }));
    expect(out.waitingOn).toBeUndefined();
    expect(out.queuedStep?.jobId).toBe('a872c0b8');
  });

  it('carries the next attempt time when the step is inside its retry cooldown', () => {
    const retryAfterAt = new Date(NOW.getTime() + 45_000);
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [queuedJob({ retryAfterAt })] }));
    expect(out.waitingOn?.reason).toBe('retry_cooldown');
    expect(out.queuedStep?.retryAfterAt).toBe(retryAfterAt.toISOString());
  });

  it('names the queued step even when a held sibling owns waitingOn', () => {
    const held = queuedJob({ id: 'job-held', status: 'held', failureReason: 'runner_offline' });
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [held, queuedJob({ id: 'job-queued' })] }),
    );
    expect(out.waitingOn?.reason).toBe('job_held');
    expect(out.queuedStep?.jobId).toBe('job-queued');
  });

  it('omits queuedStep entirely when the issue has no queued job', () => {
    const out = classifyPipelineHealthForIssue(
      baseInput({ jobs: [queuedJob({ status: 'running', agentSessionId: 'sess-1' })] }),
    );
    expect(out.queuedStep).toBeUndefined();
  });

  it('picks the OLDEST queued job, the same candidate the dispatch picker takes', () => {
    const older = queuedJob({ id: 'job-older', queuedAt: QUEUED_AT });
    const newer = queuedJob({ id: 'job-newer', queuedAt: new Date(QUEUED_AT.getTime() + 60_000) });
    const out = classifyPipelineHealthForIssue(baseInput({ jobs: [newer, older] }));
    expect(out.queuedStep?.jobId).toBe('job-older');
  });
});

// cm:why the db mock above has `select: vi.fn()` returning undefined, so the real loader throws on `.from(...)` — which is exactly the partial-mock/DB-blip shape this wrapper exists to absorb, and the assertion is that a LIST of issues degrades instead of 500ing
describe('safeHydratePipelineHealthForIssues', () => {
  it('returns an empty map instead of throwing when the derivation fails', async () => {
    await expect(safeHydratePipelineHealthForIssues('proj-1', ['iss-903'])).resolves.toEqual(
      new Map(),
    );
  });

  it('short-circuits an empty id list without touching the db', async () => {
    await expect(safeHydratePipelineHealthForIssues('proj-1', [])).resolves.toEqual(new Map());
  });
});
