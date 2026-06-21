import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tabular DB mock: each call to `db.select()` consumes one queued response.
// The service issues:
//   1. SELECT projects.agentConfig (load current project)
//   2. SELECT issues (stagesBeingDisabled — only when disabling stages; skipped here)
//   3. SELECT skillRegistrations (AUTO_STAGE_NEEDS_SKILL — only when per-state mode='auto')
//   4. SELECT skillRegistrations (MISSING_SKILL_FOR_ENABLED_STAGE — top-level toggles)
//   5. SELECT projects.agentConfig (re-read for return value, if validation passes)
const selectQueue: unknown[][] = [];
function pushSelect(rows: unknown[]) {
  selectQueue.push(rows);
}

function buildSelectChain() {
  const rows = selectQueue.shift() ?? [];
  const chain: Record<string, unknown> = {};
  const final = async () => rows;
  chain.from = () => ({
    where: () => ({
      limit: () => final(),
      then: (onFulfilled: (v: unknown) => unknown) => final().then(onFulfilled),
    }),
  });
  return chain;
}

const dbExecute = vi.fn(async () => undefined);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => buildSelectChain(),
    execute: dbExecute,
  },
}));

const { PipelineConfigError, updatePipelineConfig, computeMergeStateParkWarning } = await import(
  './pipeline-config-service.js'
);

beforeEach(() => {
  selectQueue.length = 0;
  dbExecute.mockClear();
});

describe('updatePipelineConfig — MISSING_SKILL_FOR_ENABLED_STAGE (ISS-238)', () => {
  it('rejects when a top-level toggle is enabled but the stage has no skill registration', async () => {
    // 1. Load current project agentConfig (empty pipelineConfig).
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    // 2. AUTO_STAGE_NEEDS_SKILL: no per-state auto-mode entries → skipped.
    // 3. MISSING_SKILL_FOR_ENABLED_STAGE: skill registrations for stages with
    //    enabled toggles. Patch enables autoReview → developed must have a row.
    pushSelect([]); // no registrations for any toggle-enabled stage

    await expect(
      updatePipelineConfig({
        projectId: '00000000-0000-0000-0000-000000000001',
        patch: { enabled: true, autoReview: true },
      }),
    ).rejects.toMatchObject({
      name: 'PipelineConfigError',
      code: 'MISSING_SKILL_FOR_ENABLED_STAGE',
      details: { stagesMissingSkill: expect.arrayContaining(['developed']) },
    });
  });

  it('accepts the patch when every enabled toggle has a matching skill registration', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    // toggle-enabled stages query — return a row for `developed`.
    pushSelect([{ stage: 'developed' }]);
    // post-update re-read of agentConfig (return value path).
    pushSelect([
      { agentConfig: { pipelineConfig: { enabled: true, autoReview: true } } },
    ]);

    const result = await updatePipelineConfig({
      projectId: '00000000-0000-0000-0000-000000000001',
      patch: { autoReview: true },
    });
    expect(result.pipelineConfig).toMatchObject({ autoReview: true });
    // Update SQL ran on the projects row.
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it('still flags MISSING_SKILL when the patch only changes unrelated keys but leaves an enabled toggle without a skill', async () => {
    // The rule reads the *merged* config, so it catches projects already in a
    // broken state when the operator tries to make any pipelineConfig change.
    pushSelect([
      { agentConfig: { pipelineConfig: { enabled: true, autoReview: true } } },
    ]);
    pushSelect([]); // still no registrations

    await expect(
      updatePipelineConfig({
        projectId: '00000000-0000-0000-0000-000000000001',
        patch: { autoTriage: false },
      }),
    ).rejects.toMatchObject({
      name: 'PipelineConfigError',
      code: 'MISSING_SKILL_FOR_ENABLED_STAGE',
    });
  });
});

describe('updatePipelineConfig — AUTO_STAGE_NEEDS_SKILL delta-validation (ISS-382)', () => {
  it('accepts a session-groups save that re-asserts mode:auto for skill-less stages (no transition)', async () => {
    // The session-groups editor wholesale-replaces `states`, and GET
    // read-normalizes every stage to enabled:true/mode:'auto'. The stored
    // config has no per-state overrides and the project has NO skills.
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    // No AUTO_STAGE_NEEDS_SKILL query expected (needRegistration is empty —
    // every stage was already effectively auto+enabled before). No toggle
    // query either (no autoX toggles enabled). Just the post-update re-read.
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);

    const result = await updatePipelineConfig({
      projectId: '00000000-0000-0000-0000-000000000001',
      patch: {
        sessionGroups: { build: ['open', 'confirmed'] },
        states: {
          open: { enabled: true, mode: 'auto', sessionGroup: 'build' },
          confirmed: { enabled: true, mode: 'auto', sessionGroup: 'build' },
          developed: { enabled: true, mode: 'auto' },
        },
      },
    });
    expect(result.pipelineConfig).toBeDefined();
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it('still flags a stage this patch transitions from disabled into enabled+auto without a skill', async () => {
    // current: developed explicitly disabled. Patch flips it to enabled+auto.
    pushSelect([
      { agentConfig: { pipelineConfig: { states: { developed: { enabled: false } } } } },
    ]);
    // AUTO_STAGE_NEEDS_SKILL registrations query → no skill for `developed`.
    pushSelect([]);

    await expect(
      updatePipelineConfig({
        projectId: '00000000-0000-0000-0000-000000000001',
        patch: { states: { developed: { enabled: true, mode: 'auto' } } },
      }),
    ).rejects.toMatchObject({
      name: 'PipelineConfigError',
      code: 'AUTO_STAGE_NEEDS_SKILL',
      details: { stagesMissingSkill: expect.arrayContaining(['developed']) },
    });
  });
});

describe('PipelineConfigError', () => {
  it('exposes a stable code union including the ISS-238 code', () => {
    // Compile-time assertion via runtime construction (the union widens on
    // typo); failing this test means the public error shape regressed.
    const err = new PipelineConfigError(
      'MISSING_SKILL_FOR_ENABLED_STAGE',
      'msg',
      {},
    );
    expect(err.code).toBe('MISSING_SKILL_FOR_ENABLED_STAGE');
  });
});

describe('computeMergeStateParkWarning — silent-wedge advisory', () => {
  it('warns when baseBranch is a manual stage', () => {
    const w = computeMergeStateParkWarning({
      enabled: true,
      mergeStates: { baseBranch: 'tested', productionBranch: 'released' },
      states: { tested: { mode: 'manual', enabled: true } },
    } as never);
    expect(w).toMatch(/manual stage/);
    expect(w).toMatch(/tested/);
  });

  it("warns when baseBranch's step auto-toggle is off (e.g. released + autoRelease:false)", () => {
    const w = computeMergeStateParkWarning({
      enabled: true,
      autoRelease: false,
      mergeStates: { baseBranch: 'released', productionBranch: 'released' },
      states: {},
    } as never);
    expect(w).toMatch(/autoRelease/);
  });

  it('no warning when baseBranch auto-advances (testing + autoTest on)', () => {
    expect(
      computeMergeStateParkWarning({
        enabled: true,
        autoTest: true,
        mergeStates: { baseBranch: 'testing', productionBranch: 'released' },
        states: {},
      } as never),
    ).toBeNull();
  });

  it('no warning for default released when autoRelease is unset (treated as on)', () => {
    expect(
      computeMergeStateParkWarning({
        enabled: true,
        mergeStates: { baseBranch: 'released', productionBranch: 'released' },
        states: {},
      } as never),
    ).toBeNull();
  });
});
