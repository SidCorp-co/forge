// Tabular DB mock: each call to `db.select()` consumes one queued response, in
// the order the service issues them — load the project, read the issues at any
// stage being disabled, re-read the project for the return value.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { PipelineConfigError, updatePipelineConfig } = await import('./pipeline-config-service.js');

beforeEach(() => {
  selectQueue.length = 0;
  dbExecute.mockClear();
});

describe('PipelineConfigError', () => {
  it('exposes a stable code union', () => {
    const err = new PipelineConfigError('STAGE_POOL_UNKNOWN_RUNNER', 'msg', {});
    expect(err.code).toBe('STAGE_POOL_UNKNOWN_RUNNER');
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

// cm:why ISS-917 AC3 / B5 — the schema's `superRefine` sees ONE document. A patch carrying half of a forbidden pair passes on its own, so without a merged-doc re-validation the pair reaches storage in two writes and the rule the schema declares is enforceable only against operators who write it in one.
describe('updatePipelineConfig — CONFIG_CONFLICT (merged-document rules)', () => {
  const PROJECT = '00000000-0000-0000-0000-000000000001';

  it('refuses intakeGate:true landing on a stored draft backlog, naming both settings', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { poolBacklog: { statuses: ['draft'] } } } }]);

    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        patch: { intakeGate: { enabled: true } } as never,
      }),
    ).rejects.toMatchObject({ name: 'PipelineConfigError', code: 'CONFIG_CONFLICT' });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('refuses a draft backlog landing on a stored intakeGate — the other ordering', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { intakeGate: { enabled: true } } } }]);

    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        patch: { poolBacklog: { statuses: ['draft'] } } as never,
      }),
    ).rejects.toMatchObject({ name: 'PipelineConfigError', code: 'CONFIG_CONFLICT' });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('names both settings in the message an operator reads', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { intakeGate: { enabled: true } } } }]);
    const err: unknown = await updatePipelineConfig({
      projectId: PROJECT,
      patch: { poolBacklog: { statuses: ['draft'] } } as never,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PipelineConfigError);
    const conflict = err as InstanceType<typeof PipelineConfigError>;
    expect(conflict.message).toContain('intakeGate');
    expect(conflict.message).toContain('draft');
    expect(conflict.details.path).toBe('poolBacklog.statuses');
  });

  it('lets the legal half through (a non-draft status beside an on intake gate)', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { intakeGate: { enabled: true } } } }]);
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        patch: { poolBacklog: { statuses: ['on_hold'] } } as never,
      }),
    ).resolves.toBeTruthy();
    expect(dbExecute).toHaveBeenCalled();
  });

  // cm:guard a config already unparseable is NOT this write's doing. Refusing here would answer an unrelated edit with a rule the operator did not break, and leave them no edit that succeeds — including the one that fixes it.
  it('does not refuse when the STORED config was already invalid', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { poolBacklog: { statuses: ['open'] } } } }]);
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    await expect(
      updatePipelineConfig({ projectId: PROJECT, patch: { enabled: true } as never }),
    ).resolves.toBeTruthy();
  });
});
