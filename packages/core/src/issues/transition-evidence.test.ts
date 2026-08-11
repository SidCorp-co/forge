/**
 * `checkTransitionEvidence` / `planRequiredRule` — ISS-819 requirement 1: an
 * issue must not reach `approved` with a blank `plan` when the project's
 * plan stage is live. Device actors only (a human hand-advance is a
 * recorded human decision); `skip:true` exempts the orchestrator's curated
 * soft-skip/failover chain.
 */

import { describe, expect, it, vi } from 'vitest';

// cm:why queued by call order: the plan_required rule's own `issues.plan` read, then (only if blank) `isPlanStageLive`'s `projects.agentConfig` read
const queue: unknown[][] = [];
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    }),
  },
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resolverStages = vi.fn<() => Promise<Set<string>>>(async () => new Set(['clarified']));
vi.mock('../pipeline/skill-mapping.js', () => ({
  createProjectSkillResolver: () => ({ stages: resolverStages }),
}));

const { checkTransitionEvidence, isBlankPlan } = await import('./transition-evidence.js');

const ISSUE = { id: 'iss-1', projectId: 'proj-1' };

function setup(...batches: unknown[][]) {
  queue.length = 0;
  queue.push(...batches);
}

const planRow = (plan: string | null) => [{ plan }];
const projectRow = (pipelineConfig: unknown) => [{ agentConfig: { pipelineConfig } }];

describe('isBlankPlan', () => {
  it.each([null, undefined, '', '   ', '\n\t'])('treats %j as blank', (v) => {
    expect(isBlankPlan(v)).toBe(true);
  });

  it.each(['a plan', '  a plan  '])('treats %j as non-blank', (v) => {
    expect(isBlankPlan(v)).toBe(false);
  });
});

describe('checkTransitionEvidence — plan_required rule', () => {
  it('blocks a device transition to approved with a blank plan on a plan-stage-live project', async () => {
    setup(planRow(null), projectRow({ enabled: true }));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'approved',
      actorType: 'device',
      skip: false,
    });
    expect(violation).toEqual({
      code: 'PLAN_REQUIRED',
      detail: 'issue has no plan written — write the issue plan before advancing to approved',
      details: { issueId: 'iss-1' },
    });
  });

  it('allows a user actor even with a blank plan (device-only enforcement)', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'approved',
      actorType: 'user',
      skip: false,
    });
    expect(violation).toBeNull();
  });

  it('allows options.skip:true (auto-skip/failover chain unaffected)', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'approved',
      actorType: 'device',
      skip: true,
    });
    expect(violation).toBeNull();
  });

  it('allows a non-blank plan', async () => {
    setup(planRow('a real plan'));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'approved',
      actorType: 'device',
      skip: false,
    });
    expect(violation).toBeNull();
  });

  it('allows when the project has no clarified stage registered', async () => {
    resolverStages.mockResolvedValueOnce(new Set());
    setup(planRow(null), projectRow({ enabled: true }));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'approved',
      actorType: 'device',
      skip: false,
    });
    expect(violation).toBeNull();
  });

  it('allows when states.clarified.enabled is explicitly false', async () => {
    setup(planRow(null), projectRow({ enabled: true, states: { clarified: { enabled: false } } }));
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'approved',
      actorType: 'device',
      skip: false,
    });
    expect(violation).toBeNull();
  });

  it('ignores transitions to any status other than approved', async () => {
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'developed',
      actorType: 'device',
      skip: false,
    });
    expect(violation).toBeNull();
  });

  // cm:guard a broken rule check must never freeze a legitimate transition
  it('fails open when the plan read throws', async () => {
    const { db } = await import('../db/client.js');
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    const original = (db as any).select;
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = () => {
      throw new Error('connection reset');
    };
    const violation = await checkTransitionEvidence({
      issue: ISSUE,
      toStatus: 'approved',
      actorType: 'device',
      skip: false,
    });
    expect(violation).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: test-only mock override
    (db as any).select = original;
  });
});
