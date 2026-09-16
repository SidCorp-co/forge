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
  // `.for('update')` is the row lock both writers take (ISS-1038); it is
  // chainable before `.limit()` and returns the same thenable shape.
  const afterWhere = (): Record<string, unknown> => ({
    limit: () => final(),
    for: (mode: string) => {
      forUpdate(mode);
      return afterWhere();
    },
    then: (onFulfilled: (v: unknown) => unknown) => final().then(onFulfilled),
  });
  chain.from = () => ({ where: () => afterWhere() });
  return chain;
}

// Takes the fragment so a test can read the statement the service issued
// (ISS-1038); `updatePipelineConfig`'s own tests ignore it.
const dbExecute = vi.fn(async (_query?: unknown) => undefined);
/** Records `.for('update')` — the row lock both writers take (ISS-1038). */
const forUpdate = vi.fn((_mode?: string) => undefined);

// ISS-1038 — both writers now run inside `db.transaction`, taking a row lock so
// a stale whole-map save cannot land on top of a one-key sentinel write. The
// stub hands the callback a `tx` with the same surface, so these tests still
// exercise the merge rather than the transaction plumbing; the serialisation
// itself is proved against real Postgres in
// tests/integration/mcp-injection-concurrency.test.ts, which is the only place
// it CAN be proved.
const tx = {
  select: () => buildSelectChain(),
  execute: dbExecute,
};

vi.mock('../db/client.js', () => ({
  db: {
    select: () => buildSelectChain(),
    execute: dbExecute,
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));

const { PipelineConfigError, updatePipelineConfig, setMcpServerSentinel } = await import(
  './pipeline-config-service.js'
);

beforeEach(() => {
  selectQueue.length = 0;
  dbExecute.mockClear();
  forUpdate.mockClear();
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
        patch: {
          states: { awaiting_release: { deviceIds: [DEVICE_OK, DEVICE_MISSING] } },
        } as never,
      }),
    ).rejects.toMatchObject({
      name: 'PipelineConfigError',
      code: 'STAGE_POOL_UNKNOWN_RUNNER',
      details: {
        stagesWithUnknownDevices: [{ stage: 'awaiting_release', deviceIds: [DEVICE_MISSING] }],
      },
    });
  });

  it('accepts a pool whose every device has a runner on this project', async () => {
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
      patch: { states: { awaiting_release: { deviceIds: [DEVICE_OK] } } } as never,
    });
    expect(result.pipelineConfig.states?.awaiting_release?.deviceIds).toEqual([DEVICE_OK]);
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

// ISS-1038 — the Integrations panel's switch knows one provider's answer and
// nothing about the rest of `mcpServers`. `updatePipelineConfig` replaces that
// map wholesale from whatever the caller last read, so a switch built on it
// would drop any key another tab had added in between — the
// `wholesale-config-clobber` affordance this repo already names. These pin the
// property that makes the new write safe: ONE key, in ONE statement, and never
// a re-sent map.
describe('setMcpServerSentinel (ISS-1038)', () => {
  const PROJECT = '00000000-0000-0000-0000-000000000009';

  /** The statement the service issued, with its bound parameters, flattened out
   *  of drizzle's fragment — the SQL text and the values it carries, as one
   *  string. A bare JSON.stringify of the fragment escapes the bound JSON, so a
   *  `toContain` over it silently matches nothing. */
  function lastSql(): string {
    const frag = dbExecute.mock.calls.at(-1)?.[0] as { queryChunks?: unknown[] } | undefined;
    const parts: string[] = [];
    const walk = (node: unknown): void => {
      if (node == null) return;
      if (typeof node === 'string') {
        parts.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const n of node) walk(n);
        return;
      }
      if (typeof node === 'object' && 'value' in (node as Record<string, unknown>)) {
        walk((node as { value: unknown }).value);
      }
    };
    walk(frag?.queryChunks ?? []);
    return parts.join(' ');
  }

  // What these can prove is the map this write PROJECTS from what it read.
  // They cannot prove the property that matters most — that the read and the
  // write are serialised against the other writer of this document — because a
  // mocked `db.execute` has no row to lose and no lock to take. That is proved
  // in tests/integration/mcp-injection-concurrency.test.ts against real
  // Postgres, which is also where a statement this file called correct was
  // found to be rejected outright (22P02).

  it('projects the stored map with the one key added', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { mcpServers: { playwright: true } } } }]);

    await setMcpServerSentinel({ projectId: PROJECT, name: 'epodsystem', enabled: true });

    expect(dbExecute).toHaveBeenCalledTimes(1);
    const sql = lastSql();
    // The whole map is written, and it is the map READ UNDER THE LOCK a moment
    // earlier — which is why carrying the siblings here is not the clobber the
    // `wholesale-config-clobber` flag names. A caller's stale map never
    // reaches this statement.
    expect(sql).toContain('"playwright":true');
    expect(sql).toContain('"epodsystem":true');
  });

  it('takes the row lock before it reads', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { mcpServers: {} } } }]);
    await setMcpServerSentinel({ projectId: PROJECT, name: 'sentry', enabled: true });
    expect(forUpdate).toHaveBeenCalled();
  });

  it('writes the bare boolean and nothing that could carry a credential', async () => {
    pushSelect([{ agentConfig: { pipelineConfig: { mcpServers: {} } } }]);

    await setMcpServerSentinel({ projectId: PROJECT, name: 'sentry', enabled: true });

    const sql = lastSql();
    expect(sql).toContain('{"sentry":true}');
    expect(sql).not.toContain('Authorization');
    expect(sql).not.toContain('headers');
    expect(sql).not.toContain('Bearer');
  });

  it('drops EVERY matching sentinel when disabling, and nothing else', async () => {
    pushSelect([
      {
        agentConfig: {
          pipelineConfig: {
            mcpServers: {
              epodsystem: true,
              epodsystem_store_a: true,
              epodsystem_custom: { type: 'stdio' },
              playwright: true,
              sentry: true,
            },
          },
        },
      },
    ]);

    await setMcpServerSentinel({ projectId: PROJECT, name: 'epodsystem', enabled: false });

    const sql = lastSql();
    expect(sql).not.toContain('"epodsystem":true');
    expect(sql).not.toContain('"epodsystem_store_a":true');
    // An object under a matching name is a raw custom spec, not a sentinel.
    expect(sql).toContain('"epodsystem_custom"');
    expect(sql).toContain('"playwright":true');
    expect(sql).toContain('"sentry":true');
  });

  it('refuses a project that does not exist, and writes nothing', async () => {
    pushSelect([]);
    await expect(
      setMcpServerSentinel({ projectId: PROJECT, name: 'sentry', enabled: true }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(dbExecute).not.toHaveBeenCalled();
  });
});
