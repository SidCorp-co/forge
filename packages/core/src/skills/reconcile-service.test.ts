import { RECONCILE_GATES, RECONCILE_RUN_STATUSES, RECONCILE_VERDICTS } from '@forge/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:why `tables`, when set, routes `.limit()` by the real table object passed to `.from()` so one query (e.g. runners) can resolve different rows than another (e.g. skills) in the same test; unset keeps every query resolving to `rows`.
// cm:why `txSelect`/`txReturning` are the transaction-scoped analogues — keyed by table, consulted only inside `db.transaction`'s callback, so a run's FOR-UPDATE select and a guarded UPDATE...returning() on the SAME table can resolve independently.
const dbStub = vi.hoisted(() => ({
  rows: [] as unknown[],
  tables: null as Map<unknown, unknown[]> | null,
  txSelect: null as Map<unknown, unknown[]> | null,
  txReturning: null as Map<unknown, unknown[]> | null,
}));
vi.mock('../db/client.js', () => {
  const build = (table?: unknown): unknown => ({
    from: (t: unknown) => build(t),
    where: () => build(table),
    limit: () => Promise.resolve(dbStub.tables ? (dbStub.tables.get(table) ?? []) : dbStub.rows),
    // cm:why a query with no .limit() (the device-observation read) still has to resolve — without this the chain object itself is awaited and reaches the caller as a non-array
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(dbStub.tables ? (dbStub.tables.get(table) ?? []) : dbStub.rows).then(
        res,
        rej,
      ),
    leftJoin: () => build(table),
    orderBy: () => build(table),
    groupBy: () => build(table),
  });
  const buildTx = (table?: unknown): unknown => ({
    from: (t: unknown) => buildTx(t),
    where: () => buildTx(table),
    for: () => buildTx(table),
    set: () => buildTx(table),
    limit: () => Promise.resolve(dbStub.txSelect?.get(table) ?? []),
    returning: () => Promise.resolve(dbStub.txReturning?.get(table) ?? []),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(dbStub.txSelect?.get(table) ?? []).then(res, rej),
  });
  const tx = {
    select: () => buildTx(),
    update: (table: unknown) => buildTx(table),
  };
  return {
    db: {
      select: () => build(),
      transaction: (fn: (t: unknown) => unknown) => Promise.resolve(fn(tx)),
    },
  };
});
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../pipeline/runs.js', () => ({ openOneShotRun: vi.fn() }));
vi.mock('../jobs/enqueue.js', () => ({ enqueueReconcileJob: vi.fn() }));
const activityMock = vi.hoisted(() => ({
  recordSkillActivityEvent: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('./activity.js', () => ({
  recordSkillActivityEvent: activityMock.recordSkillActivityEvent,
}));
vi.mock('./policy-landed.js', () => ({
  ensurePolicyLandedFor: vi.fn().mockResolvedValue(false),
}));
const notifyMock = vi.hoisted(() => ({
  emitNotification: vi.fn().mockResolvedValue({ id: 'n-1' }),
}));
vi.mock('../notifications/emit.js', () => ({ emitNotification: notifyMock.emitNotification }));
const resolveMock = vi.hoisted(() => ({ resolveNotifications: vi.fn().mockResolvedValue(0) }));
vi.mock('../notifications/auto-resolve.js', () => ({
  resolveNotifications: resolveMock.resolveNotifications,
}));

import {
  deviceSkills,
  divergenceCharters,
  jobs,
  organizationMembers,
  projectMembers,
  projects,
  reconcileGates,
  reconcileRunStatuses,
  reconcileRuns,
  reconcileVerdicts,
  runners,
  skillActivityEvents,
  skills,
  updatePackets,
} from '../db/schema.js';
import type { ReconcileBundleSnapshot } from '../db/schema.js';
import {
  acknowledgeReconcileRun,
  applyReconcileRun,
  isRunningBodyObserved,
  recordReconcileVerdict,
  recordVerifierVote,
  rejectReconcileRun,
  spawnReconcileRun,
  validateC1C5,
} from './reconcile-service.js';

// cm:why contracts/reconcile.ts tuples must mirror db/schema.ts
describe('reconcile contract parity', () => {
  it('RECONCILE_VERDICTS matches schema', () => {
    expect([...RECONCILE_VERDICTS].sort()).toEqual([...reconcileVerdicts].sort());
  });
  it('RECONCILE_RUN_STATUSES matches schema', () => {
    expect([...RECONCILE_RUN_STATUSES].sort()).toEqual([...reconcileRunStatuses].sort());
  });
  it('RECONCILE_GATES matches schema', () => {
    expect([...RECONCILE_GATES].sort()).toEqual([...reconcileGates].sort());
  });
});

describe('isRunningBodyObserved', () => {
  const H = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);

  it('is false with no observation at all — nothing proves what runs', () => {
    expect(isRunningBodyObserved(H, [])).toBe(false);
    expect(isRunningBodyObserved(H, [{ observedSha: null, shadowedBy: null }])).toBe(false);
  });

  it('is true when every reporting device observed exactly the stored body', () => {
    expect(
      isRunningBodyObserved(H, [
        { observedSha: H, shadowedBy: null },
        { observedSha: H, shadowedBy: null },
      ]),
    ).toBe(true);
  });

  // A device still on the previous body means the stored copy is NOT what runs there,
  // so the bundle must not claim observation — C4 then refuses the run.
  it('is false when any device observed a different body', () => {
    expect(
      isRunningBodyObserved(H, [
        { observedSha: H, shadowedBy: null },
        { observedSha: OTHER, shadowedBy: null },
      ]),
    ).toBe(false);
  });

  it('is false when a device reports the right hash but a shadowing copy (ISS-783)', () => {
    expect(isRunningBodyObserved(H, [{ observedSha: H, shadowedBy: '~/.claude/skills' }])).toBe(
      false,
    );
  });

  it('is false when the skill has no stored hash to compare against', () => {
    expect(isRunningBodyObserved(null, [{ observedSha: H, shadowedBy: null }])).toBe(false);
  });
});

describe('validateC1C5', () => {
  const validBundle: ReconcileBundleSnapshot = {
    readAt: new Date().toISOString(),
    change: 'Add a clarification step',
    story: 'Users need clearer requirements',
    intentClass: 'procedure',
    appliesTo: 'forge-code',
    provenance: {},
    runningBody: 'some body',
    runningHash: 'abc123',
    charter: null,
    projectFacts: {},
    pipelineConfig: {},
    recentRunEvidence: [],
    priorReconcileHistory: [],
    invariantSet: {},
    mustNotBreak: [],
    sources: {
      change: 'from-code',
      story: 'human',
      intentClass: 'human',
      appliesTo: 'from-code',
      runningBody: 'observed-from-run',
      runningHash: 'observed-from-run',
    },
  };

  it('returns null for a valid bundle', () => {
    expect(validateC1C5(validBundle)).toBeNull();
  });

  it('C1: refuses when change is missing', () => {
    const reason = validateC1C5({ ...validBundle, change: '' });
    expect(reason).toMatch(/C1.*change/);
  });

  it('C1: refuses when story is missing', () => {
    const reason = validateC1C5({ ...validBundle, story: '' });
    expect(reason).toMatch(/C1.*story/);
  });

  it('C2: refuses when readAt is stale (>10 minutes ago)', () => {
    const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const reason = validateC1C5({ ...validBundle, readAt: stale });
    expect(reason).toMatch(/C2.*stale/);
  });

  it('C2: refuses when readAt is not a valid timestamp', () => {
    const reason = validateC1C5({ ...validBundle, readAt: 'not-a-date' });
    expect(reason).toMatch(/C2.*valid ISO/);
  });

  it('C3: refuses when sources map is empty', () => {
    const reason = validateC1C5({ ...validBundle, sources: {} });
    expect(reason).toMatch(/C3.*sources/);
  });

  it('C4: refuses when story is not labelled human', () => {
    const reason = validateC1C5({
      ...validBundle,
      sources: { ...validBundle.sources, story: 'agent-assertion' },
    });
    expect(reason).toMatch(/C4.*story/);
  });

  it('C4: refuses when runningBody is not labelled observed-from-run', () => {
    const reason = validateC1C5({
      ...validBundle,
      sources: { ...validBundle.sources, runningBody: 'agent-assertion' },
    });
    expect(reason).toMatch(/C4.*runningBody/);
  });
});

describe('spawnReconcileRun — refusal events', () => {
  const input = {
    projectId: 'proj-1',
    packetId: 'pkt-1',
    skillId: 'skill-1',
    actorUserId: 'user-1',
  };

  it('pinned: emits reconcile.failed/skipped event', async () => {
    dbStub.tables = null;
    dbStub.rows = [{ pinned: true, pinnedReason: 'intentional divergence' }];
    activityMock.recordSkillActivityEvent.mockClear();
    const result = await spawnReconcileRun(input);
    expect(result).toMatchObject({ ok: false, reason: 'pinned' });
    expect(activityMock.recordSkillActivityEvent).toHaveBeenCalledOnce();
    expect(activityMock.recordSkillActivityEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'reconcile.failed',
        outcome: 'skipped',
        projectId: input.projectId,
        skillId: input.skillId,
        packetId: input.packetId,
      }),
    );
  });

  it('c1-c5-refused: emits reconcile.failed/skipped event with refusal reason, omitting skillId for a nonexistent skill', async () => {
    dbStub.tables = null;
    dbStub.rows = [];
    activityMock.recordSkillActivityEvent.mockClear();
    const result = await spawnReconcileRun(input);
    expect(result).toMatchObject({ ok: false, reason: 'c1-c5-refused' });
    expect(activityMock.recordSkillActivityEvent).toHaveBeenCalledOnce();
    const call = activityMock.recordSkillActivityEvent.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(call.eventType).toBe('reconcile.failed');
    expect(call.outcome).toBe('skipped');
    expect(call.reason).toMatch(/C1/);
    // cm:why guards BLOCKER AD — forwarding skillId for a nonexistent skill would 23503 against skill_activity_events_skill_id_skills_id_fk.
    expect(call.skillId).toBeUndefined();
  });

  it('no-runner: emits reconcile.failed/skipped event when bundle is valid but no runner is online', async () => {
    dbStub.tables = new Map<unknown, unknown[]>([
      [
        skills,
        [
          {
            pinned: false,
            pinnedReason: null,
            id: input.skillId,
            skillMd: 'running body',
            prompt: 'running body',
            contentHash: 'hash-1',
          },
        ],
      ],
      [
        updatePackets,
        [
          {
            id: input.packetId,
            change: 'Add a clarification step',
            story: 'Users need clearer requirements',
            intentClass: 'procedure',
            appliesTo: 'forge-code',
            provenance: {},
          },
        ],
      ],
      [projects, [{ agentConfig: {} }]],
      // cm:why must AGREE with contentHash — a device observing a different sha is the stale case, which now labels runningBody `from-code` and makes C4 refuse before the runner check this test targets
      [deviceSkills, [{ observedSha: 'hash-1', shadowedBy: null }]],
      [divergenceCharters, []],
      [reconcileRuns, []],
      [skillActivityEvents, []],
      [runners, []],
    ]);
    activityMock.recordSkillActivityEvent.mockClear();
    const result = await spawnReconcileRun(input);
    expect(result).toMatchObject({ ok: false, reason: 'no-runner' });
    expect(activityMock.recordSkillActivityEvent).toHaveBeenCalledOnce();
    expect(activityMock.recordSkillActivityEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'reconcile.failed',
        outcome: 'skipped',
        projectId: input.projectId,
        skillId: input.skillId,
        packetId: input.packetId,
        reason: 'no online runner bound to this project',
      }),
    );
  });
});

describe('reconcile gate notifications (ISS-807)', () => {
  const adminRows = new Map<unknown, unknown[]>([
    [projects, [{ id: 'proj-1', orgId: 'org-1', name: 'Acme' }]],
    [projectMembers, [{ userId: 'admin-1' }]],
    [organizationMembers, [{ userId: 'org-admin-1' }]],
  ]);

  beforeEach(() => {
    dbStub.tables = adminRows;
    dbStub.txSelect = null;
    dbStub.txReturning = null;
    notifyMock.emitNotification.mockClear();
    resolveMock.resolveNotifications.mockClear();
    activityMock.recordSkillActivityEvent.mockClear();
  });

  it('recordReconcileVerdict: verdict=escalate notifies every effective admin once', async () => {
    dbStub.txSelect = new Map<unknown, unknown[]>([
      [
        reconcileRuns,
        [
          {
            id: 'run-1',
            projectId: 'proj-1',
            status: 'running',
            skillId: 'skill-1',
            packetId: 'pkt-1',
          },
        ],
      ],
    ]);
    dbStub.txReturning = new Map<unknown, unknown[]>([[reconcileRuns, [{ id: 'run-1' }]]]);

    await recordReconcileVerdict({
      runId: 'run-1',
      verdict: 'escalate',
      candidateBody: null,
      rationale: 'too risky to decide alone',
      gate: 'human',
      actor: 'agent:master',
    });

    expect(notifyMock.emitNotification).toHaveBeenCalledTimes(2);
    const userIds = notifyMock.emitNotification.mock.calls.map((c) => c[0].userId).sort();
    expect(userIds).toEqual(['admin-1', 'org-admin-1']);
    expect(notifyMock.emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconcile_gate_pending',
        resolutionKey: 'reconcile_run:run-1:gate',
      }),
    );
  });

  it('recordReconcileVerdict: a duplicate transition (guarded UPDATE matches zero rows) emits nothing', async () => {
    dbStub.txSelect = new Map<unknown, unknown[]>([
      [
        reconcileRuns,
        [
          {
            id: 'run-1',
            projectId: 'proj-1',
            status: 'running',
            skillId: 'skill-1',
            packetId: 'pkt-1',
          },
        ],
      ],
    ]);
    dbStub.txReturning = new Map<unknown, unknown[]>([[reconcileRuns, []]]);

    await recordReconcileVerdict({
      runId: 'run-1',
      verdict: 'escalate',
      candidateBody: null,
      rationale: 'too risky to decide alone',
      gate: 'human',
      actor: 'agent:master',
    });

    expect(notifyMock.emitNotification).not.toHaveBeenCalled();
  });

  it('recordVerifierVote: the vote completing a human-gate majority pass notifies every admin', async () => {
    dbStub.txSelect = new Map<unknown, unknown[]>([
      [
        reconcileRuns,
        [
          {
            id: 'run-1',
            projectId: 'proj-1',
            status: 'verifying',
            gate: 'human',
            skillId: 'skill-1',
            packetId: 'pkt-1',
            verifierVotes: [
              { jobId: 'job-1', vote: 'pass', reason: 'ok', decidedAt: new Date().toISOString() },
              { jobId: 'job-3', vote: 'pass', reason: 'ok', decidedAt: new Date().toISOString() },
            ],
          },
        ],
      ],
      [jobs, [{ id: 'job-2', retryOf: null }]],
    ]);
    dbStub.txReturning = new Map<unknown, unknown[]>([[reconcileRuns, [{ id: 'run-1' }]]]);

    await recordVerifierVote({
      runId: 'run-1',
      jobId: 'job-2',
      vote: 'pass',
      reason: 'looks fine',
    });

    expect(notifyMock.emitNotification).toHaveBeenCalledTimes(2);
    expect(notifyMock.emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconcile_gate_pending',
        resolutionKey: 'reconcile_run:run-1:gate',
      }),
    );
  });

  it('applyReconcileRun: auto-resolves the gate notification for every admin after commit', async () => {
    dbStub.txSelect = new Map<unknown, unknown[]>([
      [
        reconcileRuns,
        [
          {
            id: 'run-1',
            projectId: 'proj-1',
            status: 'decided',
            skillId: 'skill-1',
            packetId: 'pkt-1',
            candidateBody: 'new body',
            lastGoodHash: 'hash-0',
          },
        ],
      ],
      [skills, [{ files: [] }]],
    ]);

    await applyReconcileRun('run-1', 'admin-1');

    expect(resolveMock.resolveNotifications).toHaveBeenCalledWith('reconcile_run:run-1:gate');
  });

  it('rejectReconcileRun: auto-resolves the gate notification for every admin after commit', async () => {
    dbStub.txSelect = new Map<unknown, unknown[]>([
      [
        reconcileRuns,
        [
          {
            id: 'run-1',
            projectId: 'proj-1',
            status: 'decided',
            skillId: 'skill-1',
            packetId: 'pkt-1',
          },
        ],
      ],
    ]);

    await rejectReconcileRun('run-1', 'admin-1', 'not convinced');

    expect(resolveMock.resolveNotifications).toHaveBeenCalledWith('reconcile_run:run-1:gate');
  });

  it('acknowledgeReconcileRun: rejects a run that is not escalated/verdict=escalate', async () => {
    dbStub.txSelect = new Map<unknown, unknown[]>([
      [reconcileRuns, [{ id: 'run-1', status: 'decided', verdict: 'apply', acknowledgedAt: null }]],
    ]);

    await expect(acknowledgeReconcileRun('run-1', 'admin-1')).rejects.toThrow(/^BAD_REQUEST:/);
    expect(activityMock.recordSkillActivityEvent).not.toHaveBeenCalled();
  });

  it('acknowledgeReconcileRun: is idempotent on an already-acknowledged run', async () => {
    dbStub.txSelect = new Map<unknown, unknown[]>([
      [
        reconcileRuns,
        [
          {
            id: 'run-1',
            status: 'escalated',
            verdict: 'escalate',
            acknowledgedAt: new Date().toISOString(),
          },
        ],
      ],
    ]);

    await acknowledgeReconcileRun('run-1', 'admin-1');

    expect(activityMock.recordSkillActivityEvent).not.toHaveBeenCalled();
  });

  it('acknowledgeReconcileRun: clears the gate notification and logs the event', async () => {
    dbStub.txSelect = new Map<unknown, unknown[]>([
      [
        reconcileRuns,
        [
          {
            id: 'run-1',
            projectId: 'proj-1',
            status: 'escalated',
            verdict: 'escalate',
            skillId: 'skill-1',
            packetId: 'pkt-1',
            acknowledgedAt: null,
          },
        ],
      ],
    ]);

    await acknowledgeReconcileRun('run-1', 'admin-1');

    expect(activityMock.recordSkillActivityEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'reconcile.acknowledged' }),
    );
    expect(resolveMock.resolveNotifications).toHaveBeenCalledWith('reconcile_run:run-1:gate');
  });
});
