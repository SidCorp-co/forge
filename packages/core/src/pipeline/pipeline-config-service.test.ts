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

const {
  PipelineConfigError,
  updatePipelineConfig,
  computeMergeStateParkWarning,
  isBaseBranchStampable,
} = await import('./pipeline-config-service.js');

beforeEach(() => {
  selectQueue.length = 0;
  dbExecute.mockClear();
});

describe('PipelineConfigError', () => {
  it('exposes a stable code union', () => {
    const err = new PipelineConfigError('MISSING_SKILL_FOR_ENABLED_STAGE', 'msg', {});
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

// ISS-639 — blocks-gate `closed` bypass in dispatch-gates.ts must be
// conditional on this exact predicate: single source of truth shared by the
// gate (dispatch-time) and the sweeper (park-time).
describe('isBaseBranchStampable', () => {
  it('false when baseBranch is a manual stage (mirrors computeMergeStateParkWarning)', () => {
    expect(
      isBaseBranchStampable({
        enabled: true,
        mergeStates: { baseBranch: 'tested', productionBranch: 'released' },
        states: { tested: { mode: 'manual', enabled: true } },
      } as never),
    ).toBe(false);
  });

  it("false when baseBranch's step auto-toggle is off", () => {
    expect(
      isBaseBranchStampable({
        enabled: true,
        autoRelease: false,
        mergeStates: { baseBranch: 'released', productionBranch: 'released' },
        states: {},
      } as never),
    ).toBe(false);
  });

  it('false when baseBranch stage is explicitly disabled', () => {
    expect(
      isBaseBranchStampable({
        enabled: true,
        mergeStates: { baseBranch: 'testing', productionBranch: 'released' },
        states: { testing: { enabled: false, mode: 'auto' } },
      } as never),
    ).toBe(false);
  });

  it('true for a normal auto-advancing base (testing + autoTest on)', () => {
    expect(
      isBaseBranchStampable({
        enabled: true,
        autoTest: true,
        mergeStates: { baseBranch: 'testing', productionBranch: 'released' },
        states: {},
      } as never),
    ).toBe(true);
  });

  it('true for default released base when unconfigured', () => {
    expect(
      isBaseBranchStampable({
        enabled: true,
        mergeStates: { baseBranch: 'released', productionBranch: 'released' },
        states: {},
      } as never),
    ).toBe(true);
  });
});

describe('updatePipelineConfig — STAGE_POOL_UNKNOWN_RUNNER (per-state runner pool)', () => {
  const PROJECT = '00000000-0000-0000-0000-000000000001';
  const DEVICE_OK = '11111111-1111-4111-8111-111111111111';
  const DEVICE_MISSING = '22222222-2222-4222-8222-222222222222';

  // cm:why a pool naming a device with no runner on the project produces a job nothing can place — queued forever while the fleet reads healthy — so the write is the only moment an operator can be told about the typo
  it('rejects a pool naming a device with no runner on this project', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    pushSelect([{ deviceId: DEVICE_OK }]);

    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        patch: { states: { released: { deviceIds: [DEVICE_OK, DEVICE_MISSING] } } } as never,
      }),
    ).rejects.toMatchObject({
      name: 'PipelineConfigError',
      code: 'STAGE_POOL_UNKNOWN_RUNNER',
      details: {
        stagesWithUnknownDevices: [{ stage: 'released', deviceIds: [DEVICE_MISSING] }],
      },
    });
  });

  it('accepts a pool whose every device has a runner on this project', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    pushSelect([{ deviceId: DEVICE_OK }]);
    pushSelect([
      { agentConfig: { pipelineConfig: { states: { released: { deviceIds: [DEVICE_OK] } } } } },
    ]);

    const result = await updatePipelineConfig({
      projectId: PROJECT,
      patch: { states: { released: { deviceIds: [DEVICE_OK] } } } as never,
    });
    expect(result.pipelineConfig.states?.released?.deviceIds).toEqual([DEVICE_OK]);
  });
});

describe('updatePipelineConfig — round-trips', () => {
  const PROJECT = '00000000-0000-0000-0000-000000000001';

  it('round-trips lockedSkills instead of stripping it', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    pushSelect([{ agentConfig: { pipelineConfig: { lockedSkills: ['forge-drive'] } } }]);

    const result = await updatePipelineConfig({
      projectId: PROJECT,
      patch: { lockedSkills: ['forge-drive'] },
    });

    expect(result.pipelineConfig.lockedSkills).toEqual(['forge-drive']);
  });
});
