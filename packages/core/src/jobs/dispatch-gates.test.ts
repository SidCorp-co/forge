/**
 * ISS-40 PR-E — gate-helper unit tests. Mocks db.execute / db.select with
 * scripted return values so each layer's threshold + reason mapping can be
 * asserted in isolation. Heavyweight DB-integration coverage lives in the
 * runtime sweep tests (dispatch-tick.test.ts via the dispatcher integration).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbExecute = vi.fn();
const dbSelect = vi.fn();
const dbUpdate = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    execute: dbExecute,
    select: dbSelect,
    update: dbUpdate,
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  checkLayer1IssueBusy,
  checkLayer2Dependencies,
  checkLayer3ProjectFull,
  checkLayer4RunnerFull,
  pickNextDispatchableJobForProject,
  countInFlightForRunner,
  DEFAULT_MAX_CONCURRENT_ISSUES,
} = await import('./dispatch-gates.js');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

function selectChainOnce(rows: unknown[]): void {
  dbSelect.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({ limit: async () => rows }),
    }),
  }));
}

describe('checkLayer1IssueBusy', () => {
  // ISS-42 C1 added a manual_hold short-circuit before the existing busy
  // check. Each test now queues a `manualHold: false` lookup first so the
  // existing assertions still exercise the busy-check branch.
  it('passes when no active sessions or jobs for the issue', async () => {
    selectChainOnce([{ manualHold: false }]);
    dbExecute.mockResolvedValueOnce([{ count: '0' }]);
    selectChainOnce([]);
    const r = await checkLayer1IssueBusy('iss-1');
    expect(r.pass).toBe(true);
  });

  it('fails when an active session exists for the same issue', async () => {
    selectChainOnce([{ manualHold: false }]);
    dbExecute.mockResolvedValueOnce([{ count: '2' }]);
    selectChainOnce([]);
    const r = await checkLayer1IssueBusy('iss-1');
    expect(r).toMatchObject({ pass: false, reason: 'issue_busy' });
  });

  it('fails when an active job exists for the same issue', async () => {
    selectChainOnce([{ manualHold: false }]);
    dbExecute.mockResolvedValueOnce([{ count: '0' }]);
    selectChainOnce([{ id: 'j-other' }]);
    const r = await checkLayer1IssueBusy('iss-1');
    expect(r).toMatchObject({ pass: false, reason: 'issue_busy' });
  });

  it('fails with manual_hold when issue is on hold', async () => {
    selectChainOnce([{ manualHold: true }]);
    const r = await checkLayer1IssueBusy('iss-1');
    expect(r).toMatchObject({ pass: false, reason: 'manual_hold' });
  });

  it('passes for empty issueId (PM-style call)', async () => {
    const r = await checkLayer1IssueBusy('');
    expect(r.pass).toBe(true);
  });
});

describe('checkLayer2Dependencies', () => {
  it('passes when no blocking edges exist', async () => {
    dbExecute.mockResolvedValueOnce([]);
    const r = await checkLayer2Dependencies('iss-1');
    expect(r.pass).toBe(true);
  });

  it('passes when all blocking parents are terminal', async () => {
    dbExecute.mockResolvedValueOnce([
      { from_issue_id: 'p1', iss_seq: 12, status: 'closed' },
      { from_issue_id: 'p2', iss_seq: 13, status: 'released' },
    ]);
    const r = await checkLayer2Dependencies('iss-1');
    expect(r.pass).toBe(true);
  });

  it('fails when at least one blocking parent is not terminal', async () => {
    dbExecute.mockResolvedValueOnce([
      { from_issue_id: 'p1', iss_seq: 12, status: 'closed' },
      { from_issue_id: 'p2', iss_seq: 13, status: 'in_progress' },
    ]);
    const r = await checkLayer2Dependencies('iss-1');
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.reason).toBe('waiting_on_dep');
      const waitingOn = r.metadata?.waitingOn as Array<{ issSeq: number }>;
      expect(waitingOn).toHaveLength(1);
      expect(waitingOn[0]?.issSeq).toBe(13);
    }
  });
});

describe('checkLayer3ProjectFull', () => {
  function projectAgentConfigOnce(value: Record<string, unknown> | null): void {
    selectChainOnce([{ agentConfig: value }]);
  }

  it('passes when running issues < cap', async () => {
    projectAgentConfigOnce({ pipelineConfig: { maxConcurrentIssues: 3 } });
    dbExecute.mockResolvedValueOnce([{ issue_id: 'a' }, { issue_id: 'b' }]);
    const r = await checkLayer3ProjectFull('proj-1');
    expect(r.pass).toBe(true);
  });

  it('fails when distinct running issues meet cap (excludes candidate)', async () => {
    projectAgentConfigOnce({ pipelineConfig: { maxConcurrentIssues: 2 } });
    dbExecute.mockResolvedValueOnce([{ issue_id: 'a' }, { issue_id: 'b' }]);
    const r = await checkLayer3ProjectFull('proj-1', 'c');
    expect(r).toMatchObject({ pass: false, reason: 'project_full' });
  });

  it('passes when candidate issue is already counted', async () => {
    projectAgentConfigOnce({ pipelineConfig: { maxConcurrentIssues: 2 } });
    dbExecute.mockResolvedValueOnce([{ issue_id: 'a' }, { issue_id: 'b' }]);
    const r = await checkLayer3ProjectFull('proj-1', 'a');
    expect(r.pass).toBe(true);
  });

  it('falls back to default cap when config missing', async () => {
    projectAgentConfigOnce(null);
    // Default cap is 3 — set 3 distinct issues to fail.
    dbExecute.mockResolvedValueOnce([
      { issue_id: 'a' },
      { issue_id: 'b' },
      { issue_id: 'c' },
    ]);
    const r = await checkLayer3ProjectFull('proj-1', 'd');
    expect(r.pass).toBe(false);
    expect(DEFAULT_MAX_CONCURRENT_ISSUES).toBe(3);
  });
});

describe('checkLayer4RunnerFull', () => {
  function runnerCapsOnce(value: { type: string; capabilities: Record<string, unknown> } | null): void {
    selectChainOnce(value ? [value] : []);
  }

  it('passes when runner row vanished (race)', async () => {
    runnerCapsOnce(null);
    const r = await checkLayer4RunnerFull('r-x');
    expect(r.pass).toBe(true);
  });

  it('passes when in-flight < cap', async () => {
    runnerCapsOnce({ type: 'claude-code', capabilities: { maxConcurrent: 3 } });
    dbExecute.mockResolvedValueOnce([{ count: '1' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r.pass).toBe(true);
  });

  it('fails when in-flight reaches cap', async () => {
    runnerCapsOnce({ type: 'claude-code', capabilities: { maxConcurrent: 2 } });
    dbExecute.mockResolvedValueOnce([{ count: '2' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r).toMatchObject({ pass: false, reason: 'runner_full' });
  });

  it('uses claude-code default of 2 when capability missing', async () => {
    runnerCapsOnce({ type: 'claude-code', capabilities: {} });
    dbExecute.mockResolvedValueOnce([{ count: '2' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r.pass).toBe(false);
  });

  it('uses antigravity default of 5 when capability missing', async () => {
    runnerCapsOnce({ type: 'antigravity', capabilities: {} });
    dbExecute.mockResolvedValueOnce([{ count: '4' }]);
    const r = await checkLayer4RunnerFull('r1');
    expect(r.pass).toBe(true);
  });
});

describe('countInFlightForRunner', () => {
  it('returns 0 when no rows match', async () => {
    dbExecute.mockResolvedValueOnce([{ count: '0' }]);
    expect(await countInFlightForRunner('r1')).toBe(0);
  });
  it('coerces text count to number', async () => {
    dbExecute.mockResolvedValueOnce([{ count: '7' }]);
    expect(await countInFlightForRunner('r1')).toBe(7);
  });
});

describe('pickNextDispatchableJobForProject', () => {
  it('returns null when no rows', async () => {
    dbExecute.mockResolvedValueOnce([]);
    expect(await pickNextDispatchableJobForProject('p1')).toBeNull();
  });
  it('returns the first row when present', async () => {
    dbExecute.mockResolvedValueOnce([
      { id: 'j1', projectId: 'p1', issueId: 'i1', status: 'queued' },
    ]);
    const r = await pickNextDispatchableJobForProject('p1');
    expect(r).toMatchObject({ id: 'j1' });
  });
});
