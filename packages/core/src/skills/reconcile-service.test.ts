import { RECONCILE_GATES, RECONCILE_RUN_STATUSES, RECONCILE_VERDICTS } from '@forge/contracts';
import { describe, expect, it, vi } from 'vitest';

// cm:why `tables`, when set, routes `.limit()` by the real table object passed to `.from()` so one query (e.g. runners) can resolve different rows than another (e.g. skills) in the same test; unset keeps every query resolving to `rows`.
const dbStub = vi.hoisted(() => ({
  rows: [] as unknown[],
  tables: null as Map<unknown, unknown[]> | null,
}));
vi.mock('../db/client.js', () => {
  const build = (table?: unknown): unknown => ({
    from: (t: unknown) => build(t),
    where: () => build(table),
    limit: () => Promise.resolve(dbStub.tables ? (dbStub.tables.get(table) ?? []) : dbStub.rows),
    leftJoin: () => build(table),
    orderBy: () => build(table),
    groupBy: () => build(table),
  });
  return { db: { select: () => build() } };
});
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../pipeline/runs.js', () => ({ openOneShotRun: vi.fn() }));
vi.mock('../jobs/enqueue.js', () => ({ enqueueReconcileJob: vi.fn() }));
const activityMock = vi.hoisted(() => ({ recordSkillActivityEvent: vi.fn() }));
vi.mock('./activity.js', () => ({
  recordSkillActivityEvent: activityMock.recordSkillActivityEvent,
}));
vi.mock('./policy-landed.js', () => ({
  ensurePolicyLandedFor: vi.fn().mockResolvedValue(false),
}));

import {
  divergenceCharters,
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
import { classifyGate, spawnReconcileRun, validateC1C5 } from './reconcile-service.js';

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

describe('classifyGate', () => {
  it('returns human when verdict is escalate', () => {
    expect(classifyGate('anything', 'escalate')).toBe('human');
  });

  it('returns human when change mentions merge target', () => {
    expect(classifyGate('Update merge-target from main to release', 'apply')).toBe('human');
  });

  it('returns human when change mentions auth', () => {
    expect(classifyGate('Remove auth check before dispatch', 'apply')).toBe('human');
  });

  it('returns human when change removes a gate', () => {
    expect(classifyGate('Remove the gate for auto-release', 'apply')).toBe('human');
  });

  it('returns auto for an additive, non-sensitive change', () => {
    expect(classifyGate('Add a clarification step before coding', 'apply')).toBe('auto');
  });

  it('returns auto for enhancement verdict with harmless change', () => {
    expect(classifyGate('Expand the plan description format', 'apply-with-adaptation')).toBe(
      'auto',
    );
  });

  it('returns human (fail-safe) for unrecognised change text not matching additive patterns', () => {
    expect(classifyGate('Reorganize the skill sections for readability', 'apply')).toBe('human');
  });

  it('returns human (fail-safe) for empty change text', () => {
    expect(classifyGate('', 'apply')).toBe('human');
  });

  it('returns human when change mentions skipping approval', () => {
    expect(classifyGate('Skip the approval step for fast PRs', 'apply')).toBe('human');
  });

  it('returns human when change mentions loosening a requirement', () => {
    expect(classifyGate('Loosen the requirement for code review sign-off', 'apply')).toBe('human');
  });
});

describe('validateC1C5', () => {
  const validBundle = {
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
    const call = activityMock.recordSkillActivityEvent.mock.calls[0][1];
    expect(call.eventType).toBe('reconcile.failed');
    expect(call.outcome).toBe('skipped');
    expect(call.reason).toMatch(/C1/);
    // cm:why guards BLOCKER AD — forwarding skillId for a nonexistent skill would 23503 against skill_activity_events_skill_id_skills_id_fk.
    expect(call.skillId).toBeUndefined();
  });

  it('no-runner: emits reconcile.failed/skipped event when bundle is valid but no runner is online', async () => {
    dbStub.tables = new Map([
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
            observedSha: 'sha-1',
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
