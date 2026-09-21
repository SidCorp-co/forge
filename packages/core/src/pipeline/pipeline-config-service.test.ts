// Tabular DB mock: each call to `db.select()` consumes one queued response, in
// the order the service issues them — load the project under the row lock, read
// the issues at any stage being disabled, re-read the project for the return
// value.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIPELINE_CONFIG_DEFAULTS } from './pipeline-config-schema.js';

const selectQueue: unknown[][] = [];
function pushSelect(rows: unknown[]) {
  selectQueue.push(rows);
}

/** What a caller that has just read this stored document would send as its base. */
function baseOf(stored: Record<string, unknown>): Record<string, unknown> {
  return { ...PIPELINE_CONFIG_DEFAULTS, ...stored } as Record<string, unknown>;
}

function buildSelectChain() {
  let rows: unknown[] | undefined;
  const take = () => {
    if (rows === undefined) rows = selectQueue.shift() ?? [];
    return rows;
  };
  const result: Record<string, unknown> = {};
  result.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(take()).then(onFulfilled, onRejected);
  result.limit = () => result;
  result.for = () => result;
  return { from: () => ({ where: () => result }) };
}

const dbExecute = vi.fn(async (_query?: unknown) => undefined);

vi.mock('../db/client.js', () => {
  const tx = { select: () => buildSelectChain(), execute: dbExecute };
  return {
    db: {
      select: () => buildSelectChain(),
      execute: dbExecute,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

const { hooks } = await import('./hooks.js');
const { PipelineConfigError, updatePipelineConfig } = await import('./pipeline-config-service.js');

/** Every `contractInputChanged` this suite heard, on the one bus the writer emits to. */
const heard: { projectId: string; issueId?: string; reason: string }[] = [];
hooks.on(
  'contractInputChanged',
  async (payload) => {
    heard.push(payload);
  },
  { name: 'pipeline-config-service-test-listener' },
);

beforeEach(() => {
  selectQueue.length = 0;
  dbExecute.mockClear();
  heard.length = 0;
});

const PROJECT = '00000000-0000-0000-0000-000000000001';

describe('PipelineConfigError', () => {
  it('exposes a stable code union', () => {
    const err = new PipelineConfigError('STAGE_POOL_UNKNOWN_RUNNER', 'msg', {});
    expect(err.code).toBe('STAGE_POOL_UNKNOWN_RUNNER');
  });
});

describe('updatePipelineConfig — STAGE_POOL_UNKNOWN_RUNNER (per-state runner pool)', () => {
  const DEVICE_OK = '11111111-1111-4111-8111-111111111111';
  const DEVICE_MISSING = '22222222-2222-4222-8222-222222222222';

  it('rejects a pool naming a device with no runner on this project', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    pushSelect([{ deviceId: DEVICE_OK }]);

    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        base: baseOf({}),
        patch: { states: { awaiting_release: { deviceIds: [DEVICE_OK, DEVICE_MISSING] } } },
      }),
    ).rejects.toMatchObject({
      name: 'PipelineConfigError',
      code: 'STAGE_POOL_UNKNOWN_RUNNER',
      details: {
        stagesWithUnknownDevices: [{ stage: 'awaiting_release', deviceIds: [DEVICE_MISSING] }],
      },
    });
  });

  it('accepts a pool whose every device has a runner here', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    pushSelect([{ deviceId: DEVICE_OK }]);
    pushSelect([
      {
        agentConfig: {
          pipelineConfig: { states: { awaiting_release: { deviceIds: [DEVICE_OK] } } },
        },
      },
    ]);

    const result = await updatePipelineConfig({
      projectId: PROJECT,
      base: baseOf({}),
      patch: { states: { awaiting_release: { deviceIds: [DEVICE_OK] } } },
    });
    expect(result.pipelineConfig.states?.awaiting_release?.deviceIds).toEqual([DEVICE_OK]);
  });
});

describe('updatePipelineConfig — round-trips', () => {
  it('round-trips lockedSkills instead of stripping it', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    pushSelect([{ agentConfig: { pipelineConfig: { lockedSkills: ['forge-drive'] } } }]);

    const result = await updatePipelineConfig({
      projectId: PROJECT,
      base: baseOf({}),
      patch: { lockedSkills: ['forge-drive'] },
    });

    expect(result.pipelineConfig.lockedSkills).toEqual(['forge-drive']);
  });
});

/**
 * ISS-1170 — what reaches the column. The service is handed a fragment and the
 * whole stored document has to come back out of it.
 */
describe('updatePipelineConfig — what the patch writes', () => {
  function writtenPipeline(): Record<string, unknown> {
    const arg = dbExecute.mock.calls.at(-1)?.[0] as { queryChunks?: unknown[] } | undefined;
    for (const chunk of arg?.queryChunks ?? []) {
      if (typeof chunk !== 'string' || !chunk.includes('pipelineConfig')) continue;
      return (JSON.parse(chunk) as { pipelineConfig: Record<string, unknown> }).pipelineConfig;
    }
    return {};
  }

  it('leaves a key the patch does not name where it was', async () => {
    const stored = {
      intakeGate: { enabled: true },
      states: { open: { enabled: true, allowedTools: ['Read'] } },
    };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);

    await updatePipelineConfig({
      projectId: PROJECT,
      base: baseOf(stored),
      patch: { states: { open: { allowedTools: ['Read', 'Grep'] } } },
    });

    const written = writtenPipeline();
    const open = (written.states as Record<string, unknown>).open as Record<string, unknown>;
    expect(open.enabled).toBe(true);
    expect(open.allowedTools).toEqual(['Read', 'Grep']);
    expect(written.intakeGate).toEqual({ enabled: true });
  });

  it('deletes the key a patch sets to null', async () => {
    const stored = { states: { open: { allowedTools: ['Read'], enabled: true } } };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);

    await updatePipelineConfig({
      projectId: PROJECT,
      base: baseOf(stored),
      patch: { states: { open: { allowedTools: null } } },
    });

    const written = writtenPipeline();
    const open = (written.states as Record<string, unknown>).open as Record<string, unknown>;
    expect('allowedTools' in open).toBe(false);
    expect(open.enabled).toBe(true);
  });
});

describe('updatePipelineConfig — CONFIG_STALE', () => {
  it('refuses a write whose base moved at a path it writes, and writes nothing', async () => {
    pushSelect([
      { agentConfig: { pipelineConfig: { states: { open: { allowedTools: ['Grep'] } } } } },
    ]);

    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        base: baseOf({ states: { open: { allowedTools: ['Read'] } } }),
        patch: { states: { open: { allowedTools: ['Read', 'Write'] } } },
      }),
    ).rejects.toMatchObject({
      name: 'PipelineConfigError',
      code: 'CONFIG_STALE',
      details: {
        conflicts: [
          { path: 'states.open.allowedTools', base: ['Read'], stored: ['Grep'] },
        ],
      },
    });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('names the path, what was read and what is stored', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { enabled: false } } }]);
    const err: unknown = await updatePipelineConfig({
      projectId: PROJECT,
      base: baseOf({ enabled: true }),
      patch: { enabled: false },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    const conflict = err as InstanceType<typeof PipelineConfigError>;
    expect(conflict.code).toBe('CONFIG_STALE');
    expect(conflict.message).toContain('enabled: you read true, it now holds false');
    expect(conflict.message).toContain('Nothing was written');
  });

  it('lets a write through when what moved is a path it does not touch', async () => {
    const moved = { intakeGate: { enabled: true }, lockedSkills: ['other'] };
    pushSelect([{ agentConfig: { pipelineConfig: moved } }]);
    pushSelect([{ agentConfig: { pipelineConfig: moved } }]);

    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        base: baseOf({ lockedSkills: ['other'] }),
        patch: { lockedSkills: ['forge-drive'] },
      }),
    ).resolves.toBeTruthy();
    expect(dbExecute).toHaveBeenCalled();
  });
});

describe('updatePipelineConfig — CONFIG_CONFLICT (merged-document rules)', () => {
  it('refuses intakeGate:true landing on a stored draft backlog, naming both settings', async () => {
    const stored = { poolBacklog: { statuses: ['draft'] } };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);

    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        base: baseOf(stored),
        patch: { intakeGate: { enabled: true } },
      }),
    ).rejects.toMatchObject({ name: 'PipelineConfigError', code: 'CONFIG_CONFLICT' });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('refuses a draft backlog landing on a stored intakeGate — the other ordering', async () => {
    const stored = { intakeGate: { enabled: true } };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);

    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        base: baseOf(stored),
        patch: { poolBacklog: { statuses: ['draft'] } },
      }),
    ).rejects.toMatchObject({ name: 'PipelineConfigError', code: 'CONFIG_CONFLICT' });
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('names both settings in the message an operator reads', async () => {
    const stored = { intakeGate: { enabled: true } };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);
    const err: unknown = await updatePipelineConfig({
      projectId: PROJECT,
      base: baseOf(stored),
      patch: { poolBacklog: { statuses: ['draft'] } },
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
    const stored = { intakeGate: { enabled: true } };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        base: baseOf(stored),
        patch: { poolBacklog: { statuses: ['on_hold'] } },
      }),
    ).resolves.toBeTruthy();
    expect(dbExecute).toHaveBeenCalled();
  });

  it('does not refuse when the STORED config was already invalid somewhere else', async () => {
    const stored = { poolBacklog: { statuses: ['open'] } };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    await expect(
      updatePipelineConfig({ projectId: PROJECT, base: baseOf(stored), patch: { enabled: true } }),
    ).resolves.toBeTruthy();
  });

  it('still refuses an error at a path this patch wrote, stored invalid or not', async () => {
    const stored = { poolBacklog: { statuses: ['open'] }, maxResumeTokens: -3 };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);
    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        base: baseOf(stored),
        patch: { maxResumeTokens: -1 },
      }),
    ).rejects.toMatchObject({
      name: 'PipelineConfigError',
      code: 'CONFIG_CONFLICT',
      details: { path: 'maxResumeTokens' },
    });
    expect(dbExecute).not.toHaveBeenCalled();
  });
});

/**
 * ISS-1072 — the declaration is an input to the contract's answer as much as any
 * record is, so moving it moves every open pull request's check on the project.
 */
describe('updatePipelineConfig — contractInputChanged', () => {
  it('announces a change to `statusEntryCriteria`, naming the project and no issue', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    pushSelect([
      { agentConfig: { pipelineConfig: { statusEntryCriteria: { developed: ['plan'] } } } },
    ]);

    await updatePipelineConfig({
      projectId: PROJECT,
      base: baseOf({}),
      patch: { statusEntryCriteria: { developed: ['plan'] } },
    });

    expect(heard).toHaveLength(1);
    expect(heard[0]?.projectId).toBe(PROJECT);
    expect(heard[0]?.issueId).toBeUndefined();
  });

  it('stays silent for a patch that names something else entirely', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: {} } }]);
    pushSelect([{ agentConfig: { pipelineConfig: { lockedSkills: ['forge-drive'] } } }]);

    await updatePipelineConfig({
      projectId: PROJECT,
      base: baseOf({}),
      patch: { lockedSkills: ['forge-drive'] },
    });

    expect(heard).toEqual([]);
  });

  it('announces nothing when the write was refused', async () => {
    const stored = { poolBacklog: { statuses: ['draft'] } };
    pushSelect([{ agentConfig: { pipelineConfig: stored } }]);
    await expect(
      updatePipelineConfig({
        projectId: PROJECT,
        base: baseOf(stored),
        patch: { intakeGate: { enabled: true } },
      }),
    ).rejects.toMatchObject({ name: 'PipelineConfigError' });
    expect(heard).toEqual([]);
  });
});
