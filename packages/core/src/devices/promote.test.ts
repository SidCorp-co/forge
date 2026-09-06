// The dependencies promote OWNS are mocked, not the rules it enforces: the
// transition and the dispatch are stubs so the ORDER of the checks, the shape
// of every refusal, and what is left behind when dispatch produces no job are
// each observable without a database.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:why Stub eager env validation (config/env.js throws at import when DATABASE_URL / JWT_SECRET / DEVICE_TOKEN_PEPPER are absent) so this unit suite stays hermetic — same pattern as session-failure.test.ts. Reached here through `autonomous-dispatch.js`, whose real `isEntryGateClosed` this file deliberately keeps: the gate is the rule under test, not a collaborator to stub out.
vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const execute = vi.fn();
const selectQueue: unknown[][] = [];
function pushSelect(rows: unknown[]) {
  selectQueue.push(rows);
}
function buildSelectChain() {
  const rows = selectQueue.shift() ?? [];
  return {
    from: () => ({
      where: () => ({ limit: async () => rows }),
    }),
  };
}

const transitionIssueStatus = vi.fn(
  async (_row: unknown, _to: string, _actor: unknown, _opts?: unknown) => undefined,
);
const reEnqueueForIssue = vi.fn(async (_args: unknown) => undefined);

class TransitionError extends Error {}

vi.mock('../db/client.js', () => ({
  db: { execute, select: () => buildSelectChain() },
}));
vi.mock('../issues/apply-transition.js', () => ({ transitionIssueStatus, TransitionError }));
vi.mock('../pipeline/orchestrator.js', () => ({ reEnqueueForIssue }));
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { promoteFromBacklog } = await import('./promote.js');

const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER = 'oooooooo-oooo-4ooo-8ooo-oooooooooooo';
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ISSUE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB = 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj';
const RUN = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr';

const AUTO = { enabled: true, states: { open: { enabled: true, mode: 'auto' } } };

/** The `loadPromotable` row core reads first. `null` = no such issue here. */
function mockLoad(row: Record<string, unknown> | null) {
  execute.mockResolvedValueOnce(row ? [row] : []);
}

function loadedRow(over: Record<string, unknown> = {}) {
  return {
    id: ISSUE,
    project_id: PROJECT,
    status: 'draft',
    reopen_count: 0,
    iss_seq: 917,
    agent_config: { pipelineConfig: { ...AUTO, poolBacklog: { statuses: ['draft'] } } },
    created_by: OWNER,
    archived_at: null,
    ...over,
  };
}

/** No job and no open run: `workAlreadyExists` answers false. */
function mockNoWork() {
  mockJobsFor(null);
  mockOpenRunFor(null);
}

/** The `jobs` probe inside `workAlreadyExists`. */
function mockJobsFor(jobId: string | null) {
  pushSelect(jobId ? [{ id: jobId }] : []);
}

/** The `pipeline_runs` probe, used by `workAlreadyExists` and again by the recovery. */
function mockOpenRunFor(runId: string | null) {
  pushSelect(runId ? [{ id: runId }] : []);
}

/** What `findDriveJob` reads back after the dispatch. */
function mockDriveJob(jobId: string | null) {
  pushSelect(jobId ? [{ id: jobId }] : []);
}

function mockDevice() {
  pushSelect([{ id: DEVICE, ownerId: OWNER }]);
}

beforeEach(() => {
  execute.mockReset();
  selectQueue.length = 0;
  transitionIssueStatus.mockReset();
  transitionIssueStatus.mockResolvedValue(undefined);
  reEnqueueForIssue.mockReset();
  reEnqueueForIssue.mockResolvedValue(undefined);
});

describe('promoteFromBacklog — the happy path (AC5)', () => {
  it('moves the issue to the entry status, dispatches, and hands back the drive job id', async () => {
    mockLoad(loadedRow());
    mockNoWork();
    mockDevice();
    mockDriveJob(JOB);

    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });

    expect(out).toEqual({ ok: true, jobId: JOB, issueId: ISSUE, issueKey: 'ISS-917' });
    expect(transitionIssueStatus).toHaveBeenCalledTimes(1);
    expect(transitionIssueStatus.mock.calls[0]?.[1]).toBe('open');
    expect(reEnqueueForIssue).toHaveBeenCalledTimes(1);
  });

  // cm:guard the dispatch actor is a DEVICE with `agency:'agent'` — `actorAgency` reads it at every lifecycle gate, and a promote recorded as a human is a master wearing its owner's identity at exactly the gate ISS-917 refused to let it past.
  it('dispatches as the device, acting as an agent', async () => {
    mockLoad(loadedRow());
    mockNoWork();
    mockDevice();
    mockDriveJob(JOB);

    await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });

    expect(reEnqueueForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        issueId: ISSUE,
        status: 'open',
        actor: { type: 'device', id: DEVICE, agency: 'agent' },
      }),
    );
  });
});

describe('promoteFromBacklog — refusals are ordinary outcomes (AC7)', () => {
  // cm:guard AC9 — the load JOINs `runners`, so an issue in a project this device does not serve is indistinguishable from one that does not exist. A separate "exists but not yours" would hand a paired box a project- existence oracle its bindings do not cover.
  it('answers not_found for an issue in a project this device does not serve', async () => {
    mockLoad(null);
    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });

  it('answers not_found for an archived project', async () => {
    mockLoad(loadedRow({ archived_at: '2026-01-01T00:00:00Z' }));
    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
    expect(out).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('answers backlog_disabled when the project declared none', async () => {
    mockLoad(loadedRow({ agent_config: { pipelineConfig: AUTO } }));
    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
    expect(out).toMatchObject({ ok: false, reason: 'backlog_disabled' });
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });

  it('answers not_in_backlog when the issue sits at a status the project does not admit', async () => {
    mockLoad(
      loadedRow({
        status: 'waiting',
        agent_config: { pipelineConfig: { ...AUTO, poolBacklog: { statuses: ['draft'] } } },
      }),
    );
    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
    expect(out).toMatchObject({ ok: false, reason: 'not_in_backlog' });
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });

  it('answers issue_busy when a job already exists for the issue', async () => {
    mockLoad(loadedRow());
    mockDriveJob(JOB);
    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
    expect(out).toMatchObject({ ok: false, reason: 'issue_busy' });
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });

  it('answers issue_busy when an open run already exists for the issue', async () => {
    mockLoad(loadedRow());
    mockJobsFor(null);
    mockOpenRunFor(RUN);
    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
    expect(out).toMatchObject({ ok: false, reason: 'issue_busy' });
    expect(transitionIssueStatus).not.toHaveBeenCalled();
  });

  it('answers issue_busy when the transition itself refuses the move', async () => {
    mockLoad(loadedRow());
    mockNoWork();
    mockDevice();
    transitionIssueStatus.mockRejectedValueOnce(new TransitionError('not a legal move'));
    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
    expect(out).toMatchObject({ ok: false, reason: 'issue_busy' });
    expect(reEnqueueForIssue).not.toHaveBeenCalled();
  });

  it('every refusal names a reason and carries a detail', async () => {
    mockLoad(null);
    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(typeof out.reason).toBe('string');
    expect(out.detail.length).toBeGreaterThan(0);
  });
});

// cm:why AC6 / B3 — the gate is `isEntryGateClosed`, checked BEFORE anything moves. Promotion widens what a master may SEE, never what it may decide.
describe('promoteFromBacklog — the entry gate (AC6)', () => {
  it.each([
    ['manual', { enabled: true, states: { open: { enabled: true, mode: 'manual' } } }],
    ['disabled', { enabled: true, states: { open: { enabled: false, mode: 'auto' } } }],
    ['pipeline off', { enabled: false, states: { open: { enabled: true, mode: 'auto' } } }],
  ])(
    'refuses entry_gated when the entry stage is %s, leaving the issue where it was',
    async (_label, states) => {
      mockLoad(
        loadedRow({
          agent_config: { pipelineConfig: { ...states, poolBacklog: { statuses: ['draft'] } } },
        }),
      );
      const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });
      expect(out).toMatchObject({ ok: false, reason: 'entry_gated' });
      // cm:why The whole no-orphan guarantee is this ordering: nothing moved, so there is nothing to restore and nothing left at `open` with no run.
      expect(transitionIssueStatus).not.toHaveBeenCalled();
      expect(reEnqueueForIssue).not.toHaveBeenCalled();
    },
  );
});

// cm:why AC10 — a promote that fails AFTER the status moved leaves the issue in one of exactly two accounted-for shapes, and says which one in its reason.
describe('promoteFromBacklog — no orphan when the dispatch produces no job (AC10)', () => {
  it('restores the backlog status when no run was opened, and says so', async () => {
    mockLoad(loadedRow());
    mockNoWork();
    mockDevice();
    mockDriveJob(null);
    mockOpenRunFor(null);

    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });

    expect(out).toMatchObject({ ok: false, reason: 'dispatch_failed' });
    if (out.ok) return;
    expect(out.detail).toContain('restored');
    // cm:why moved out, then moved back
    expect(transitionIssueStatus).toHaveBeenCalledTimes(2);
    expect(transitionIssueStatus.mock.calls[1]?.[1]).toBe('draft');
  });

  // cm:guard an `open`-with-no-job row is what `resetAutonomousWedgesOnce` already scans and re-dispatches. Restoring the status here would DELETE that rescue, so the two branches are not interchangeable and the reason must say which one happened.
  it('leaves the issue at the entry status for the reconciler when a run IS open, and says so', async () => {
    mockLoad(loadedRow());
    mockNoWork();
    mockDevice();
    mockDriveJob(null);
    mockOpenRunFor(RUN);

    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });

    expect(out).toMatchObject({ ok: false, reason: 'dispatch_failed' });
    if (out.ok) return;
    expect(out.detail).toContain(RUN);
    expect(out.detail).toContain('not stranded');
    expect(transitionIssueStatus).toHaveBeenCalledTimes(1);
  });

  it('says the issue must be moved by hand when even the restore fails', async () => {
    mockLoad(loadedRow());
    mockNoWork();
    mockDevice();
    mockDriveJob(null);
    mockOpenRunFor(null);
    transitionIssueStatus.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('db'));

    const out = await promoteFromBacklog({ deviceId: DEVICE, issueId: ISSUE });

    expect(out).toMatchObject({ ok: false, reason: 'dispatch_failed' });
    if (out.ok) return;
    expect(out.detail).toContain('by hand');
  });
});
