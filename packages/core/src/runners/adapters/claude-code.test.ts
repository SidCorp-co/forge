import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchInput } from '../types.js';

const mintJobToken = vi.fn(async () => 'forge_pat_dev_tok' as string | null);
vi.mock('../../jobs/job-token.js', () => ({
  mintJobToken: (...a: unknown[]) => mintJobToken(...(a as [])),
}));

const publish = vi.fn((..._args: unknown[]) => 1);

vi.mock('../../ws/server.js', () => ({
  roomManager: { publish: (...args: unknown[]) => publish(...args) },
}));

const selectLimit = vi.fn(async () => [] as Array<{ issSeq: number }>);
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => selectLimit() }) }),
    }),
  },
}));

const { claudeCodeAdapter } = await import('./claude-code.js');
const { deviceRoom } = await import('../../ws/rooms.js');
const { classifyBoxFault } = await import('../attribute-failure.js');

type Runner = DispatchInput['runner'];

function runner(over: Partial<Runner> = {}): Runner {
  return {
    id: 'r-1',
    projectId: 'p-1',
    type: 'claude-code',
    host: 'device',
    deviceId: 'd-1',
    name: 'desk',
    labels: [],
    capabilities: {},
    config: {},
    status: 'online',
    lastSeenAt: new Date(),
    lastError: null,
    limitReason: null,
    rateLimitedUntil: null,
    limitDetail: null,
    quarantinedUntil: null,
    quarantineReason: null,
    ...over,
  };
}

// cm:guard narrow the published frame HERE, once, instead of `calls[0]?.[1] as …` at each site — every one of those was an unsafe optional chain that read `.data` off a possibly-undefined value, so a test whose dispatch never published died on a TypeError instead of failing on the assertion it was written for.
function publishedData(): Record<string, unknown> {
  const call = publish.mock.calls[0];
  expect(call).toBeDefined();
  return (call?.[1] as { data: Record<string, unknown> }).data;
}

async function dispatchWith(agentConfig: unknown): Promise<Record<string, unknown>> {
  // cm:guard `issueId: null` so `issueKeyOf` returns without selecting — this fixture then queues exactly ONE row and it is unambiguously the config read. With an issue id the two selects are told apart only by call order, which is a test that breaks on a refactor rather than on the rule.
  selectLimit.mockResolvedValueOnce([{ agentConfig }] as never);
  await claudeCodeAdapter.dispatch({
    job: {
      id: 'job-sm',
      projectId: 'p-1',
      issueId: null,
      attempts: 0,
      createdBy: 'u1',
      type: 'code',
      payload: {},
      dispatchedAt: new Date('2026-08-29T00:00:00.000Z'),
    } as never,
    runner: runner(),
  });
  return publishedData();
}

describe('claude-code adapter', () => {
  beforeEach(() => {
    publish.mockClear();
    publish.mockReturnValue(1);
    // cm:guard reset the QUEUE, not just the calls — `mockResolvedValueOnce` values that no test consumed spill into the next one, and a leaked row is read as this test's own fixture. Four tests failed that way when the adapter grew its second select.
    selectLimit.mockReset();
    selectLimit.mockResolvedValue([] as never);
  });

  // cm:guard the DEFAULT direction is the whole safety of the phase 3 opt-in. `sessionMode` inverts a project's process model, so every shape that is not the literal 'duplex' — absent config, absent key, an unknown value — must read as print. A default that leaked the other way flips the fleet on a release nobody measured, which is phase 5's job and is bounded by a measured window.
  it('opts a project in only on the literal duplex', async () => {
    expect((await dispatchWith({ pipelineConfig: { sessionMode: 'duplex' } })).sessionMode).toBe(
      'duplex',
    );
  });

  it.each([
    ['no agentConfig at all', null],
    ['no pipelineConfig', {}],
    ['no sessionMode key', { pipelineConfig: {} }],
    ['an explicit print', { pipelineConfig: { sessionMode: 'print' } }],
    ['a value nobody recognises', { pipelineConfig: { sessionMode: 'stream-json' } }],
    ['the wrong case', { pipelineConfig: { sessionMode: 'Duplex' } }],
  ])('stays print with %s', async (_label, cfg) => {
    expect((await dispatchWith(cfg)).sessionMode).toBe('print');
  });

  // cm:guard a positive number ONLY, and the OMISSION is the contract: the key defaults to 0, no project has set it, and forwarding 0 is indistinguishable on the wire from a project asking for no residency at all. `resolve_residency` on the runner resolves absent and 0 to the same default for exactly this reason — sending 0 here would only work while the two sides happen to agree, and the moment one reads it literally residency is off fleet-wide.
  it.each([
    ['an unset key', { pipelineConfig: { sessionMode: 'duplex' } }],
    ['an explicit zero', { pipelineConfig: { sessionMode: 'duplex', sessionResidencySeconds: 0 } }],
    ['a string', { pipelineConfig: { sessionMode: 'duplex', sessionResidencySeconds: '600' } }],
    ['a negative', { pipelineConfig: { sessionMode: 'duplex', sessionResidencySeconds: -1 } }],
  ])('sends no residency for %s', async (_label, cfg) => {
    expect(await dispatchWith(cfg)).not.toHaveProperty('sessionResidencySeconds');
  });

  it('forwards a residency the project actually configured', async () => {
    const data = await dispatchWith({
      pipelineConfig: { sessionMode: 'duplex', sessionResidencySeconds: 3600 },
    });
    expect(data.sessionResidencySeconds).toBe(3600);
  });

  // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs — without `issueKey` the runner declines to salvage a failed job's working copy at all (it cannot tell this job's checkout from a stale one), so dropping this field disables L1 with nothing going red.
  it('forwards issueKey so a failed job can have its working copy salvaged', async () => {
    selectLimit.mockResolvedValueOnce([{ issSeq: 862 }]);
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-9',
        projectId: 'p-1',
        issueId: 'i-1',
        attempts: 3,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date('2026-04-26T00:00:00.000Z'),
      },
      runner: runner(),
    });
    const data = publishedData();
    expect(data.issueKey).toBe('ISS-862');
    expect(data.attempts).toBe(3);
  });

  it('omits issueKey rather than failing the dispatch when the lookup throws', async () => {
    selectLimit.mockRejectedValueOnce(new Error('db down'));
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-10',
        projectId: 'p-1',
        issueId: 'i-1',
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date('2026-04-26T00:00:00.000Z'),
      },
      runner: runner(),
    });
    expect(result.status).toBe('dispatched');
    const data = publishedData();
    expect(data.issueKey).toBeUndefined();
  });

  it('publishes job.assigned to the device room and returns dispatched', async () => {
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: { prompt: 'hi' },
        dispatchedAt: new Date('2026-04-26T00:00:00.000Z'),
      },
      runner: runner(),
    });
    expect(result.status).toBe('dispatched');
    expect(publish).toHaveBeenCalledTimes(1);
    const call = publish.mock.calls[0];
    expect(call?.[0]).toBe(deviceRoom('d-1'));
    expect((call?.[1] as { event: string }).event).toBe('job.assigned');
  });

  it('forwards agentSessionId in the WS payload when provided', async () => {
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
        agentSessionId: 'sess-abc',
      },
      runner: runner(),
    });
    const call = publish.mock.calls[0];
    const data = (call?.[1] as { data: { agentSessionId?: string } }).data;
    expect(data.agentSessionId).toBe('sess-abc');
  });

  it('forwards systemPrompt in the WS payload when provided', async () => {
    const sp = '## Pipeline Rules\n- Status LAST.';
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-sp',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        promptString: '/forge-code iss-1',
        systemPrompt: sp,
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    const data = publishedData();
    expect(data.systemPrompt).toBe(sp);
  });

  it('publishes systemPrompt as null when not provided', async () => {
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-no-sp',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    const data = publishedData();
    expect(data.systemPrompt).toBeNull();
  });

  it('omits agentSessionId from the payload when not provided', async () => {
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    const call = publish.mock.calls[0];
    const data = (call?.[1] as { data: Record<string, unknown> }).data;
    expect('agentSessionId' in data).toBe(false);
  });

  // cm:why the frame is the only delivery — the runner has no catch-up fetch — so reporting `dispatched` for 0 subscribers spends a runner slot on a job that can only die at the ack reaper, and since ISS-862 counts those toward quarantine it would set aside every runner on a project during a core-side WS fault
  it('reports failed, not dispatched, when the frame reached no open socket', async () => {
    publish.mockReturnValueOnce(0);
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-undelivered',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    expect(result.status).toBe('failed');
    expect(result.errorReason).toContain('0 subscribers');
  });

  // cm:guard this string must stay unrecognisable to `classifyBoxFault` (attribute-failure.ts) — an undelivered dispatch is as likely to be core's websocket as the box's, so it must NOT extend a quarantine streak; the moment it reads `dispatch_unclaimed` or starts `preflight_failed:` this whole fix inverts into the fleet-wide quarantine it exists to prevent
  it('names the undelivered dispatch in words quarantine does not count', async () => {
    publish.mockReturnValueOnce(0);
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-undelivered-2',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    expect(classifyBoxFault(result.errorReason ?? null)).toBeNull();
  });

  it('returns failed when runner has no deviceId', async () => {
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-2',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner({ id: 'r-2', deviceId: null, name: 'orphan', lastSeenAt: null }),
    });
    expect(result.status).toBe('failed');
    expect(publish).not.toHaveBeenCalled();
  });

  it('validateConfig accepts empty config and rejects unknown keys', () => {
    expect(claudeCodeAdapter.validateConfig({}).ok).toBe(true);
    const r = claudeCodeAdapter.validateConfig({ skillsDir: '/tmp', bogus: 1 });
    expect(r.ok).toBe(false);
  });

  it('health reports stale when lastSeenAt is too old', async () => {
    const r = await claudeCodeAdapter.health({
      runner: runner({ id: 'r-3', name: 'old', lastSeenAt: new Date(Date.now() - 200_000) }),
    });
    expect(r.ok).toBe(false);
  });
});

describe('the job token on the dispatch frame', () => {
  beforeEach(() => {
    publish.mockClear();
    publish.mockReturnValue(1);
    selectLimit.mockReset();
    selectLimit.mockResolvedValue([] as never);
    mintJobToken.mockReset();
    mintJobToken.mockResolvedValue('forge_pat_dev_tok');
  });

  it('puts the minted job token on the frame, scoped to the job it dispatched', async () => {
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    expect(mintJobToken).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1', projectId: 'p-1', createdBy: 'u1' }),
    );
    const data = publishedData();
    expect(data.patToken).toBe('forge_pat_dev_tok');
  });

  // cm:guard the mint must never be able to fail a dispatch — a box provisioned by hand still works without a token, so degrading to "no field" is strictly better than a job that does not run. Assert the ABSENCE of the key, not a null: the runner reads `Option<JobToken>` and an explicit null would deserialise the same, but only an omitted field leaves an older core's frame shape unchanged.
  it('dispatches without the field when the mint fails', async () => {
    mintJobToken.mockResolvedValueOnce(null);
    const result = await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-1',
        projectId: 'p-1',
        issueId: null,
        attempts: 1,
        createdBy: 'u1',
        type: 'code',
        payload: {},
        dispatchedAt: new Date(),
      },
      runner: runner(),
    });
    expect(result.status).toBe('dispatched');
    const data = publishedData();
    expect('patToken' in data).toBe(false);
  });
});

describe('sessionMode is orthogonal to pipeline mode', () => {
  beforeEach(() => {
    publish.mockClear();
    publish.mockReturnValue(1);
    selectLimit.mockReset();
    selectLimit.mockResolvedValue([] as never);
  });

  // cm:guard `sessionMode` and `mode` are ORTHOGONAL and this is the only thing asserting it. Every project running duplex today is also `autonomous`, so staged+duplex is a combination the fleet has never executed — which makes it exactly the combination a reader will assume is unsupported, and a dispatcher that started gating duplex on `mode` would break nothing any other test can see. This pins the dispatch contract only: core forwards what the project asked for. It says nothing about how a staged prompt behaves inside a resident session.
  it.each([
    ['staged', 'code'],
    ['staged', 'review'],
    ['autonomous', 'drive'],
  ])('forwards duplex on a %s project dispatching a %s job', async (mode, type) => {
    selectLimit.mockResolvedValueOnce([
      { agentConfig: { pipelineConfig: { mode, sessionMode: 'duplex' } } },
    ] as never);
    await claudeCodeAdapter.dispatch({
      job: {
        id: 'job-orth',
        projectId: 'p-1',
        issueId: null,
        attempts: 0,
        createdBy: 'u1',
        type,
        payload: {},
        dispatchedAt: new Date('2026-09-01T00:00:00.000Z'),
      } as never,
      runner: runner(),
    });
    expect(publishedData().sessionMode).toBe('duplex');
  });
});
