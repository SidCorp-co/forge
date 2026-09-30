import { describe, expect, it, vi } from 'vitest';
import type { DeployAdapter, DeploymentRecord } from './deploy-adapters/types.js';
import {
  type EnvironmentStateDeps,
  type ProbeOutcome,
  resolveEnvironmentState,
} from './environment-state.js';
import type { EnvironmentDeclaration } from './schema.js';

const SHA = '47f061d78ca5ae2de8005f703fae0b8e8a454da3';
const OTHER = 'c59b3f450a8ca14b6c9317490089a4eb98cafc44';
const BINDING = '9d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60';
const VERSION_URL = 'https://forge-dev-api.sidcorp.co/version';

const record = (over: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  id: 'xo484gwk8cwsocoswo08wwcc',
  status: 'succeeded',
  at: '2026-09-30T19:14:01.000Z',
  sourceRevision: SHA,
  artifact: null,
  ...over,
});

const declared = (over: Partial<EnvironmentDeclaration> = {}): EnvironmentDeclaration => ({
  tier: 'dev',
  deploysFrom: 'dev',
  deployment: { binding: BINDING, trigger: 'on-land' },
  verification: {
    runtime: [{ type: 'http', url: VERSION_URL, path: 'sourceCommit', identifies: 'source' }],
  },
  ...over,
});

const answering =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

function deps(
  latest: DeploymentRecord | null,
  fetchImpl: typeof fetch = answering({ sourceCommit: SHA }),
  onProbe?: (environment: string, outcome: ProbeOutcome) => void,
): EnvironmentStateDeps & { adapter: DeployAdapter } {
  const adapter: DeployAdapter = {
    provider: 'coolify',
    latestDeployment: vi.fn(async () => latest),
    deployment: vi.fn(async () => null),
  };
  return {
    adapter,
    deployAdapterFor: async (id) => (id === BINDING ? { adapter, target: { app: 'a' } } : null),
    fetch: fetchImpl,
    probeTimeoutMs: 50,
    ...(onProbe ? { onProbe } : {}),
  };
}

describe('resolveEnvironmentState — evidence', () => {
  it('is runtime-confirmed when the probe reads the revision the record names', async () => {
    expect(await resolveEnvironmentState('dev', declared(), deps(record()))).toEqual({
      environment: 'dev',
      state: 'deployed',
      evidence: 'runtime-confirmed',
      deployment: {
        id: 'xo484gwk8cwsocoswo08wwcc',
        provider: 'coolify',
        status: 'succeeded',
        at: '2026-09-30T19:14:01.000Z',
      },
      artifact: null,
      source: { revision: SHA },
    });
  });

  it('is runtime-mismatch when the probe reads another revision', async () => {
    const state = await resolveEnvironmentState(
      'dev',
      declared(),
      deps(record(), answering({ sourceCommit: OTHER })),
    );
    expect(state.evidence).toBe('runtime-mismatch');
    expect(state.source).toEqual({ revision: SHA });
  });

  it('confirms a probe that reports the short form of the recorded revision', async () => {
    const state = await resolveEnvironmentState(
      'dev',
      declared(),
      deps(record(), answering({ sourceCommit: SHA.slice(0, 12) })),
    );
    expect(state.evidence).toBe('runtime-confirmed');
  });

  it('does not confirm a probe that reads a prefix shorter than a revision', async () => {
    const state = await resolveEnvironmentState(
      'dev',
      declared(),
      deps(record(), answering({ sourceCommit: SHA.slice(0, 4) })),
    );
    expect(state.evidence).toBe('runtime-mismatch');
  });

  it('is deployment-record when the environment declares no probe', async () => {
    const fetchImpl = vi.fn();
    const { verification: _none, ...bare } = declared();
    const state = await resolveEnvironmentState(
      'dev',
      bare,
      deps(record(), fetchImpl as unknown as typeof fetch),
    );
    expect(state.evidence).toBe('deployment-record');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is none, with state unknown, for an external environment, reading nothing', async () => {
    const d = deps(record());
    const lookup = vi.spyOn(d, 'deployAdapterFor');
    const state = await resolveEnvironmentState(
      'dev',
      declared({ deployment: { mode: 'external' } }),
      d,
    );
    expect(state).toEqual({ environment: 'dev', state: 'unknown', evidence: 'none' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('is none, with state unknown, when the platform has no deployment on record', async () => {
    expect(await resolveEnvironmentState('dev', declared(), deps(null))).toEqual({
      environment: 'dev',
      state: 'unknown',
      evidence: 'none',
    });
  });
});

describe('resolveEnvironmentState — a probe that does not answer', () => {
  const failing: [string, typeof fetch, RegExp][] = [
    ['a timeout', () => new Promise<Response>(() => {}) as never, /did not answer/],
    ['a non-200', answering({ sourceCommit: SHA }, 503), /answered HTTP 503/],
    ['a missing path', answering({ version: '1.0.0' }), /carries no string at `sourceCommit`/],
    ['a body that is not JSON', async () => new Response('<html>'), /not JSON/],
  ];

  it.each(failing)('keeps deployment-record on %s and reports why', async (_, fetchImpl, why) => {
    const seen: ProbeOutcome[] = [];
    const timed: typeof fetch = (url, init) =>
      Promise.race([
        fetchImpl(url, init),
        new Promise<Response>((_r, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
      ]);
    const state = await resolveEnvironmentState(
      'dev',
      declared(),
      deps(record(), timed, (_e, o) => seen.push(o)),
    );
    expect(state.evidence).toBe('deployment-record');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ok: false, reason: expect.stringMatching(why) });
  });

  it('lets one mismatching probe outweigh one that confirms', async () => {
    const two = declared({
      verification: {
        runtime: [
          { type: 'http', url: VERSION_URL, path: 'sourceCommit', identifies: 'source' },
          { type: 'http', url: `${VERSION_URL}2`, path: 'sourceCommit', identifies: 'source' },
        ],
      },
    });
    const split: typeof fetch = async (url) =>
      new Response(JSON.stringify({ sourceCommit: String(url).endsWith('2') ? OTHER : SHA }));
    const state = await resolveEnvironmentState('dev', two, deps(record(), split));
    expect(state.evidence).toBe('runtime-mismatch');
  });
});

describe('resolveEnvironmentState — artifact identity', () => {
  const artifactProbe = declared({
    verification: {
      runtime: [{ type: 'http', url: VERSION_URL, path: 'image', identifies: 'artifact' }],
    },
  });

  it('reports artifact null when the platform names none, even with a commit on record', async () => {
    const state = await resolveEnvironmentState('dev', declared(), deps(record()));
    expect(state.artifact).toBeNull();
    expect(state.source).toEqual({ revision: SHA });
  });

  it('cannot confirm an artifact probe against a record that names no artifact', async () => {
    const state = await resolveEnvironmentState(
      'dev',
      artifactProbe,
      deps(record(), answering({ image: SHA })),
    );
    expect(state.evidence).toBe('deployment-record');
  });

  it('confirms an artifact probe that reads the recorded digest', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const state = await resolveEnvironmentState(
      'dev',
      artifactProbe,
      deps(
        record({ artifact: { kind: 'container-image', id: digest } }),
        answering({ image: digest }),
      ),
    );
    expect(state.evidence).toBe('runtime-confirmed');
    expect(state.artifact).toEqual({ kind: 'container-image', id: digest });
  });
});

describe('resolveEnvironmentState — state from the latest record', () => {
  it.each([
    ['queued', 'deploying'],
    ['running', 'deploying'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
  ] as const)('reads %s as %s, and probes nothing', async (status, state) => {
    const fetchImpl = vi.fn();
    const answer = await resolveEnvironmentState(
      'dev',
      declared(),
      deps(record({ status }), fetchImpl as unknown as typeof fetch),
    );
    expect(answer.state).toBe(state);
    expect(answer.evidence).toBe('deployment-record');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports source null when the platform recorded no revision', async () => {
    const state = await resolveEnvironmentState(
      'dev',
      declared(),
      deps(record({ sourceRevision: null })),
    );
    expect(state.source).toBeNull();
    expect(state.evidence).toBe('deployment-record');
  });
});

describe('resolveEnvironmentState — refusals', () => {
  it('refuses by name a binding the project does not hold', async () => {
    const other = declared({
      deployment: { binding: '00000000-0000-4000-8000-000000000000', trigger: 'on-land' },
    });
    await expect(resolveEnvironmentState('dev', other, deps(record()))).rejects.toMatchObject({
      code: 'BINDING_NOT_FOUND',
      message: expect.stringContaining('00000000-0000-4000-8000-000000000000'),
    });
  });

  it('refuses to answer a record the state schema cannot represent', async () => {
    await expect(
      resolveEnvironmentState('dev', declared(), deps(record({ sourceRevision: 'main' }))),
    ).rejects.toThrow(/revision/);
  });

  it('carries an adapter refusal through rather than answering unknown', async () => {
    const d = deps(record());
    vi.mocked(d.adapter.latestDeployment).mockRejectedValueOnce(
      new Error('Coolify deployment d1: status "paused" is not one Forge maps'),
    );
    await expect(resolveEnvironmentState('dev', declared(), d)).rejects.toThrow(/"paused"/);
  });
});
