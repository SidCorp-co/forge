import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory mock of drizzle's chained query builder. Each describe spec
// pre-loads `selectQueue` with the row the next `select…limit(1)` should
// return; updates and inserts are recorded to `updateCalls` / `insertCalls`
// for assertion. Mirrors the style used in lifecycle-routes.test.ts.

type Row = Record<string, unknown> | undefined;

const selectQueue: Row[] = [];
const updateCalls: Array<{ table: string; set: Record<string, unknown>; where?: unknown }> = [];
const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];

const tableNames = new WeakMap<object, string>();
function tagTable(name: string) {
  const t = {};
  tableNames.set(t, name);
  return t;
}

const agentSessions = tagTable('agent_sessions');
const issues = tagTable('issues');
const jobs = tagTable('jobs');
// ISS-447 — applyKernelTransition writes the audit row here on the session sync.
const kernelTransitions = tagTable('kernel_transitions');

vi.mock('../db/schema.js', () => ({ agentSessions, issues, jobs, kernelTransitions }));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: (tbl: object) => ({
        where: () => ({
          limit: () => Promise.resolve(selectQueue.shift() ? [selectQueue.shift()!] : []),
        }),
      }),
    }),
    update: (tbl: object) => ({
      set: (s: Record<string, unknown>) => {
        updateCalls.push({ table: tableNames.get(tbl) ?? '?', set: s });
        // The non-terminal ensure-path awaits `.where()` directly; the terminal
        // session sync routes through applyKernelTransition, which chains
        // `.where().returning()`. Return a thenable that supports both.
        const call = updateCalls[updateCalls.length - 1];
        const p = Promise.resolve(undefined) as Promise<unknown> & {
          returning: () => Promise<Array<{ id: string }>>;
        };
        p.returning = () => Promise.resolve([{ id: 'sess-1' }]);
        return {
          where: (pred: unknown) => {
            if (call) call.where = pred;
            return p;
          },
        };
      },
    }),
    insert: (tbl: object) => ({
      values: (v: Record<string, unknown>) => {
        insertCalls.push({ table: tableNames.get(tbl) ?? '?', values: v });
        return { returning: () => Promise.resolve([{ id: 'sess-new' }]) };
      },
    }),
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: () => ({ _sql: 'eq' }),
  ne: (_col: unknown, v: unknown) => ({ _sql: 'ne', value: v }),
  and: (...parts: unknown[]) => ({ _sql: 'and', parts: parts.filter(Boolean) }),
}));

// ISS-101 — agent-session-link now closes one-shot pipeline_runs on terminal
// job lifecycles. Mock the runs helper so we can assert call shape without
// dragging the real db.update chain through this test.
const closeRunIfOneShotMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../pipeline/runs.js', () => ({
  closeRunIfOneShot: (...args: unknown[]) => closeRunIfOneShotMock(...args),
}));

const publishMock = vi.fn();
vi.mock('../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock('../ws/rooms.js', () => ({
  deviceRoom: (id: string) => `device:${id}`,
  projectRoom: (id: string) => `project:${id}`,
}));

const { ensureAgentSessionForJob, syncAgentSessionLifecycle } = await import(
  './agent-session-link.js'
);

function pushSelect(row: Row) {
  // The mock pulls two values per select — the first is a sentinel, the
  // second is the actual row. Push twice so the stub returns `[row]`.
  selectQueue.push({}, row);
}

const baseJob = {
  id: 'job-1',
  projectId: 'proj-1',
  issueId: null,
  deviceId: 'dev-1',
  type: 'plan',
  payload: { skillName: 'forge-plan' },
  status: 'dispatched',
  retryOf: null,
  agentSessionId: null,
  // ISS-101 — every job now belongs to a pipeline_run (NOT NULL in the DB).
  pipelineRunId: 'run-1',
};

/** A dispatch with nothing to continue — the attempt-1 shape of `ResumeRecord`. */
const FRESH_RESUME = {
  resumed: false,
  dropReason: null,
  priorClaudeSessionId: null,
  priorDeviceId: null,
  pinDeviceId: null,
  failureAction: null,
} as const;

describe('jobs/agent-session-link', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateCalls.length = 0;
    insertCalls.length = 0;
    publishMock.mockReset();
    closeRunIfOneShotMock.mockClear();
  });

  describe('ensureAgentSessionForJob', () => {
    it('returns the existing session id when the job already has one (no-op)', async () => {
      const result = await ensureAgentSessionForJob(
        { ...baseJob, agentSessionId: 'sess-existing' } as never,
        { repoPath: '/r', resume: FRESH_RESUME },
      );
      expect(result).toBe('sess-existing');
      expect(insertCalls).toHaveLength(0);
      expect(updateCalls).toHaveLength(0);
    });

    it('ISS-785 — mints a FRESH session row for a retry job instead of reusing the parent, chaining metadata + carrying pipelineHealth forward', async () => {
      pushSelect({ agentSessionId: 'sess-parent' });
      pushSelect({
        id: 'sess-parent',
        metadata: { rootSessionId: 'sess-root' },
        pipelineHealth: { recoveryStats: { totalFailures: 2 } },
      });

      const result = await ensureAgentSessionForJob(
        { ...baseJob, retryOf: 'job-0', attempts: 2 } as never,
        { repoPath: '/r', resume: FRESH_RESUME },
      );

      expect(result).toBe('sess-new');
      expect(insertCalls).toHaveLength(1);
      const inserted = insertCalls[0];
      const meta = inserted?.values.metadata as Record<string, unknown>;
      expect(meta.attempt).toBe(2);
      expect(meta.retryOfJobId).toBe('job-0');
      expect(meta.retryOfSessionId).toBe('sess-parent');
      expect(meta.rootSessionId).toBe('sess-root');
      expect(inserted?.values.pipelineHealth).toEqual({ recoveryStats: { totalFailures: 2 } });
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]?.table).toBe('jobs');
      expect(updateCalls[0]?.set.agentSessionId).toBe('sess-new');
    });

    it('ISS-785 — a retry whose parent job never got a session (defensive) still mints a fresh row, just without retryOfSessionId/rootSessionId', async () => {
      pushSelect({ agentSessionId: null });

      const result = await ensureAgentSessionForJob(
        { ...baseJob, retryOf: 'job-prev', attempts: 3 } as never,
        { repoPath: '/r', resume: FRESH_RESUME },
      );

      expect(result).toBe('sess-new');
      expect(insertCalls).toHaveLength(1);
      const meta = insertCalls[0]?.values.metadata as Record<string, unknown>;
      expect(meta.attempt).toBe(3);
      expect(meta.retryOfJobId).toBe('job-prev');
      expect(meta.retryOfSessionId).toBeUndefined();
      expect(meta.rootSessionId).toBeUndefined();
      // cm:guard a NULL-session retry clone must mint a fresh queued row, never inherit a terminal one — don't resurrect ISS-434's reuse+reset
      expect(insertCalls[0]?.values.status).toBe('queued');
    });

    it('creates a new agent_sessions row when the job has no parent session', async () => {
      pushSelect({ title: 'Fix login bug', createdById: 'user-1' });
      const result = await ensureAgentSessionForJob({ ...baseJob, issueId: 'iss-1' } as never, {
        repoPath: '/r',
        resume: FRESH_RESUME,
      });
      expect(result).toBe('sess-new');
      expect(insertCalls).toHaveLength(1);
      const inserted = insertCalls[0];
      expect(inserted?.table).toBe('agent_sessions');
      expect(inserted?.values.projectId).toBe('proj-1');
      expect(inserted?.values.userId).toBe('user-1');
      // ISS-101 — new session inherits parent job's pipeline_run so they share lifecycle.
      expect(inserted?.values.pipelineRunId).toBe('run-1');
      // ISS-34: pipeline sessions enter `queued`; worker flips to running on claim.
      expect(inserted?.values.status).toBe('queued');
      expect(inserted?.values.dispatchedAt).toBeInstanceOf(Date);
      expect(inserted?.values.title).toContain('forge-plan');
      expect(inserted?.values.title).toContain('Fix login bug');
      const meta = inserted?.values.metadata as Record<string, unknown>;
      expect(meta.type).toBe('pipeline');
      expect(meta.jobId).toBe('job-1');
      expect(meta.issueId).toBe('iss-1');
      expect(meta.skillName).toBe('forge-plan');
      // links the job to the new session
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]?.set.agentSessionId).toBe('sess-new');
      // broadcasts created event
      expect(publishMock).toHaveBeenCalled();
    });

    it("tags pm jobs with metadata.type='pm' so the pm session filter scopes them", async () => {
      // No issue lookup for project-scoped pm jobs (issueId stays null).
      const result = await ensureAgentSessionForJob(
        { ...baseJob, type: 'pm', payload: {}, issueId: null } as never,
        { repoPath: '/r', resume: FRESH_RESUME },
      );
      expect(result).toBe('sess-new');
      expect(insertCalls).toHaveLength(1);
      const meta = insertCalls[0]?.values.metadata as Record<string, unknown>;
      expect(meta.type).toBe('pm');
      expect(meta.jobType).toBe('pm');
    });

    it('ISS-887 — stamps the resume verdict on the row, so a start-from-scratch and a continue are told apart later', async () => {
      pushSelect({ title: 'Bug', createdById: 'user-1' });
      await ensureAgentSessionForJob({ ...baseJob, issueId: 'iss-9' } as never, {
        repoPath: '/r',
        resume: {
          resumed: false,
          dropReason: 'rotation',
          priorClaudeSessionId: 'claude-abc',
          priorDeviceId: 'dev-a',
          pinDeviceId: 'dev-b',
          failureAction: 'failover',
        },
      });
      const meta = insertCalls[0]?.values.metadata as Record<string, unknown>;
      expect(meta.resume).toEqual({
        resumed: false,
        dropReason: 'rotation',
        priorClaudeSessionId: 'claude-abc',
        priorDeviceId: 'dev-a',
        pinDeviceId: 'dev-b',
        failureAction: 'failover',
      });
    });

    it("keeps metadata.type='pipeline' for non-pm job types", async () => {
      pushSelect({ title: 'Bug', createdById: 'user-1' });
      await ensureAgentSessionForJob({ ...baseJob, type: 'code', issueId: 'iss-2' } as never, {
        repoPath: '/r',
        resume: FRESH_RESUME,
      });
      const meta = insertCalls[0]?.values.metadata as Record<string, unknown>;
      expect(meta.type).toBe('pipeline');
      expect(meta.jobType).toBe('code');
    });
  });

  describe('syncAgentSessionLifecycle', () => {
    it('no-ops the session update when the job has no linked session', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: null } as never, 'done');
      // No agent_sessions UPDATE — but the run still gets closed defensively
      // so PM jobs that never spawn a session don't leak open one-shot runs.
      expect(updateCalls).toHaveLength(0);
      expect(publishMock).not.toHaveBeenCalled();
      expect(closeRunIfOneShotMock).toHaveBeenCalledWith('run-1', 'completed');
    });

    it('maps done → completed and closes one-shot pipeline_run', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'done');
      expect(updateCalls[0]?.set.status).toBe('completed');
      expect(closeRunIfOneShotMock).toHaveBeenCalledWith('run-1', 'completed');
    });

    // cm:why ISS-759 — the I1 trigger stamps failure_reason on an active session when its run goes terminal and a late report then lands here; asserting only `status` let 6 rows sit `completed` WITH `orphan_under_terminal_run` for a week
    it('ISS-759: a completed session clears any failureReason the I1 trigger left behind', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'done');
      expect(updateCalls[0]?.set.status).toBe('completed');
      expect(updateCalls[0]?.set.failureReason).toBeNull();
      expect(updateCalls[0]?.set.failureDetail).toBeNull();
    });

    it('ISS-759: the cancelled→completed mapping clears it too', async () => {
      await syncAgentSessionLifecycle(
        { ...baseJob, agentSessionId: 'sess-1' } as never,
        'cancelled',
      );
      expect(updateCalls[0]?.set.status).toBe('completed');
      expect(updateCalls[0]?.set.failureReason).toBeNull();
    });

    it('ISS-759: a failed session still records why', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'failed');
      expect(updateCalls[0]?.set.status).toBe('failed');
      expect(updateCalls[0]?.set.failureReason).toBeTruthy();
    });

    it('maps cancelled → completed (enum has no cancelled); closes run as cancelled', async () => {
      await syncAgentSessionLifecycle(
        { ...baseJob, agentSessionId: 'sess-1' } as never,
        'cancelled',
      );
      expect(updateCalls[0]?.set.status).toBe('completed');
      expect(closeRunIfOneShotMock).toHaveBeenCalledWith('run-1', 'cancelled');
    });

    it('maps failed → failed and closes one-shot run as failed', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'failed');
      expect(updateCalls[0]?.set.status).toBe('failed');
      expect(closeRunIfOneShotMock).toHaveBeenCalledWith('run-1', 'failed');
    });

    it('ISS-101: skips closeRun when retryPending so the retry can pick up the same run', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'failed', {
        retryPending: true,
      });
      expect(updateCalls[0]?.set.status).toBe('failed');
      expect(closeRunIfOneShotMock).not.toHaveBeenCalled();
    });

    it('ISS-101: also skips closeRun when retryPending and job has no session', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: null } as never, 'failed', {
        retryPending: true,
      });
      expect(closeRunIfOneShotMock).not.toHaveBeenCalled();
    });
  });
});

describe('jobs/agent-session-link — ISS-877 failure cause', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    updateCalls.length = 0;
    insertCalls.length = 0;
    publishMock.mockReset();
    closeRunIfOneShotMock.mockClear();
  });

  it('ISS-877: the failure carries the job row\u2019s own cause, not a blanket marker', async () => {
    await syncAgentSessionLifecycle(
      {
        ...baseJob,
        agentSessionId: 'sess-1',
        error:
          "[RESULT_ERROR] success: You've hit your org's monthly spend limit \u00b7 run /usage-credits to ask your admin for a higher limit",
      } as never,
      'failed',
    );
    expect(updateCalls[0]?.set.failureReason).toBe('provider_spend_cap');
    expect(updateCalls[0]?.set.failureDetail).toContain('spend limit');
  });

  it('ISS-877: a job whose error names nothing the taxonomy knows lands on unclassified, never on free text', async () => {
    await syncAgentSessionLifecycle(
      { ...baseJob, agentSessionId: 'sess-1', error: 'a shape no rule has ever seen' } as never,
      'failed',
    );
    expect(updateCalls[0]?.set.failureReason).toBe('unclassified');
    expect(updateCalls[0]?.set.failureDetail).toBe('a shape no rule has ever seen');
  });

  // cm:why the sweeper's phrase is the only thing in this pair that names a cause — the error text is generic. It is NOT that `failureReason` wins by being that column: the two are joined and `CAUSE_RULES` order decides, so an error text carrying a more specific marker outranks it.
  it('ISS-877: reads the sweeper\u2019s precise failureReason when the error text names nothing', async () => {
    await syncAgentSessionLifecycle(
      {
        ...baseJob,
        agentSessionId: 'sess-1',
        failureReason: 'session_lost',
        error: 'the runner said nothing useful',
      } as never,
      'failed',
    );
    expect(updateCalls[0]?.set.failureReason).toBe('session_lost');
  });

  it('ISS-877: lets the more specific of the two columns win, whichever it is', async () => {
    await syncAgentSessionLifecycle(
      {
        ...baseJob,
        agentSessionId: 'sess-1',
        failureReason: 'session_lost',
        error: '[NO_RESULT_CLEAN_EXIT] the CLI exited with no result line',
      } as never,
      'failed',
    );
    expect(updateCalls[0]?.set.failureReason).toBe('agent_exited_without_result');
  });

  it('ISS-877: `job_failed` is not written by this path any more', async () => {
    await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'failed');
    expect(updateCalls[0]?.set.failureReason).not.toBe('job_failed');
  });

  describe('syncAgentSessionLifecycle — which writer owns the reason', () => {
    // cm:guard first writer wins on the failed branch: a session a sweeper already failed keeps ITS reason. Measured on epodsystem 2026-09-05 — 61 sessions read `session_lost` while `kernel_transitions` showed the real cause was `queue_timeout` 90s earlier, because this mirror re-failed an already-failed row and overwrote the diagnosis with its own consequence.
    const guarded = (i: number) => {
      const w = updateCalls[i]?.where as { parts?: Array<{ _sql: string; value?: unknown }> };
      return Boolean(w?.parts?.some((p) => p._sql === 'ne' && p.value === 'failed'));
    };

    it.each(['session_lost', 'dispatch_unclaimed', 'stale'])(
      'a sweeper marker (%s) must not overwrite a reason already on the row',
      async (error) => {
        await syncAgentSessionLifecycle(
          { ...baseJob, agentSessionId: 'sess-1', error } as never,
          'failed',
        );
        expect(guarded(0)).toBe(true);
      },
    );

    // cm:guard the counterpart the guard must NOT catch: ISS-877 recovers a real cause from the job row, and those still have to land on a session a sweeper already failed. A test that only pins the synthetic side passes just as well on a guard widened to every failed sync.
    it.each(['provider_spend_cap', '[SIGNAL_KILLED]', null])(
      'a real diagnosis (%s) still lands on an already-failed session',
      async (error) => {
        await syncAgentSessionLifecycle(
          { ...baseJob, agentSessionId: 'sess-1', error } as never,
          'failed',
        );
        expect(guarded(0)).toBe(false);
      },
    );

    // cm:guard the completed branch must stay UNguarded — a job reporting `done` proves the agent finished, so a session row still reading `failed` is the lie ISS-759 fixed. Guarding both branches symmetrically re-opens it.
    it('still lets a done job clear a stamped session (ISS-759)', async () => {
      await syncAgentSessionLifecycle({ ...baseJob, agentSessionId: 'sess-1' } as never, 'done');
      const w = updateCalls[0]?.where as { parts?: unknown[] };
      expect(w?.parts).toBeUndefined();
    });
  });
});
