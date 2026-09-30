import { describe, expect, it, vi } from 'vitest';
import type { DeployAdapter, DeploymentRecord } from './deploy-adapters/types.js';
import {
  type EnvironmentStateContext,
  type EnvironmentStateDeps,
  EnvironmentStateError,
  resolveEnvironmentState,
} from './environment-state.js';
import type {
  EnvironmentDeclaration,
  EnvironmentState,
  RecordedEnvironmentState,
} from './schema.js';

const SHA = '47f061d78ca5ae2de8005f703fae0b8e8a454da3';
const OTHER = 'c59b3f450a8ca14b6c9317490089a4eb98cafc44';
const BINDING = '9d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60';
const VERSION_URL = 'https://forge-dev-api.sidcorp.co/version';
const GIT: EnvironmentStateContext = { sourceType: 'git' };

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

const noProbe = (): EnvironmentDeclaration => {
  const { verification: _none, ...bare } = declared();
  return bare;
};

const answering =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

function deps(
  latest: DeploymentRecord | null | Error,
  fetchImpl: typeof fetch = answering({ sourceCommit: SHA }),
): EnvironmentStateDeps & { adapter: DeployAdapter } {
  const adapter: DeployAdapter = {
    provider: 'coolify',
    latestDeployment: vi.fn(async () => {
      if (latest instanceof Error) throw latest;
      return latest;
    }),
    deployment: vi.fn(async () => record()),
  };
  return {
    adapter,
    deployAdapterFor: async (id) => (id === BINDING ? { adapter, target: { app: 'a' } } : null),
    fetch: fetchImpl,
    probeTimeoutMs: 50,
  };
}

const recorded = (state: EnvironmentState): RecordedEnvironmentState => {
  if (state.state === 'unknown')
    throw new Error(`expected a recorded state, got ${JSON.stringify(state)}`);
  return state;
};

const unknownOf = (state: EnvironmentState) => {
  if (state.state !== 'unknown') throw new Error(`expected unknown, got ${JSON.stringify(state)}`);
  return state;
};

const resolve = (decl: EnvironmentDeclaration, d: EnvironmentStateDeps, ctx = GIT) =>
  resolveEnvironmentState('dev', decl, ctx, d);

describe('evidence and the probe outcome', () => {
  it('is runtime-confirmed, with the probe saying what it read', async () => {
    expect(await resolve(declared(), deps(record()))).toEqual({
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
      source: { kind: 'revision', revision: SHA },
      probes: [{ url: VERSION_URL, identifies: 'source', status: 'confirmed', observed: SHA }],
    });
  });

  it('is runtime-mismatch, naming what the probe read and what the record expected', async () => {
    const state = recorded(
      await resolve(declared(), deps(record(), answering({ sourceCommit: OTHER }))),
    );
    expect(state.evidence).toBe('runtime-mismatch');
    expect(state.probes).toEqual([
      {
        url: VERSION_URL,
        identifies: 'source',
        status: 'mismatch',
        observed: OTHER,
        expected: SHA,
      },
    ]);
  });

  it('confirms the short form of the recorded revision', async () => {
    const short = SHA.slice(0, 12);
    const state = recorded(
      await resolve(declared(), deps(record(), answering({ sourceCommit: short }))),
    );
    expect(state.evidence).toBe('runtime-confirmed');
  });

  it('does not confirm a prefix shorter than a revision', async () => {
    const tiny = SHA.slice(0, 4);
    const state = recorded(
      await resolve(declared(), deps(record(), answering({ sourceCommit: tiny }))),
    );
    expect(state.evidence).toBe('runtime-mismatch');
  });

  it('is deployment-record, with no probes field, when none is declared', async () => {
    const fetchImpl = vi.fn();
    const state = recorded(
      await resolve(noProbe(), deps(record(), fetchImpl as unknown as typeof fetch)),
    );
    expect(state.evidence).toBe('deployment-record');
    expect(state).not.toHaveProperty('probes');
    expect(fetchImpl).not.toHaveBeenCalled();
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
    const state = recorded(await resolve(two, deps(record(), split)));
    expect(state.evidence).toBe('runtime-mismatch');
    expect(state.probes?.map((p) => p.status)).toEqual(['confirmed', 'mismatch']);
  });

  it('lets one unreachable probe outweigh one that confirms', async () => {
    const two = declared({
      verification: {
        runtime: [
          { type: 'http', url: VERSION_URL, path: 'sourceCommit', identifies: 'source' },
          { type: 'http', url: `${VERSION_URL}2`, path: 'sourceCommit', identifies: 'source' },
        ],
      },
    });
    const split: typeof fetch = async (url) =>
      String(url).endsWith('2')
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify({ sourceCommit: SHA }));
    const state = recorded(await resolve(two, deps(record(), split)));
    expect(state.evidence).toBe('runtime-unreachable');
  });
});

describe('a probe that does not answer is unreachable, never deployment-record', () => {
  const failing: [string, typeof fetch, RegExp][] = [
    ['a timeout', () => new Promise<Response>(() => {}) as never, /did not answer \(TimeoutError/],
    ['a non-200', answering({ sourceCommit: SHA }, 503), /answered HTTP 503/],
    ['a missing path', answering({ version: '1.0.0' }), /carries no string at `sourceCommit`/],
    ['a body that is not JSON', async () => new Response('<html>'), /not JSON/],
    ['an identity too long to hold', answering({ sourceCommit: 'a'.repeat(201) }), /over the 200/],
  ];

  it.each(failing)(
    'on %s: evidence runtime-unreachable, the probe carrying its cause',
    async (_, fetchImpl, cause) => {
      const timed: typeof fetch = (url, init) =>
        Promise.race([
          fetchImpl(url, init),
          new Promise<Response>((_r, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
          ),
        ]);
      const state = recorded(await resolve(declared(), deps(record(), timed)));
      expect(state.evidence).toBe('runtime-unreachable');
      expect(state.probes).toEqual([
        {
          url: VERSION_URL,
          identifies: 'source',
          status: 'unreachable',
          error: expect.stringMatching(cause),
        },
      ]);
    },
  );
});

describe('artifact identity', () => {
  const artifactProbe = declared({
    verification: {
      runtime: [{ type: 'http', url: VERSION_URL, path: 'image', identifies: 'artifact' }],
    },
  });

  it('reports artifact null when the platform names none, even with a commit on record', async () => {
    const state = recorded(await resolve(declared(), deps(record())));
    expect(state.artifact).toBeNull();
    expect(state.source).toEqual({ kind: 'revision', revision: SHA });
  });

  it('reports an artifact probe as uncompared against a record naming no artifact', async () => {
    const state = recorded(await resolve(artifactProbe, deps(record(), answering({ image: SHA }))));
    expect(state.evidence).toBe('deployment-record');
    expect(state.probes).toEqual([
      {
        url: VERSION_URL,
        identifies: 'artifact',
        status: 'uncompared',
        observed: SHA,
        error: expect.stringContaining('records no artifact'),
      },
    ]);
  });

  it('confirms an artifact probe that reads the recorded digest', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const withImage = record({ artifact: { kind: 'container-image', id: digest } });
    const state = recorded(
      await resolve(artifactProbe, deps(withImage, answering({ image: digest }))),
    );
    expect(state.evidence).toBe('runtime-confirmed');
    expect(state.artifact).toEqual({ kind: 'container-image', id: digest });
  });
});

describe('source: a revision, unrecorded, or non-git', () => {
  it('is unrecorded when a git project has a record with no revision', async () => {
    const state = recorded(await resolve(noProbe(), deps(record({ sourceRevision: null }))));
    expect(state.source).toEqual({ kind: 'unrecorded' });
  });

  it('is non-git when the project has no git source', async () => {
    const d = deps(record({ sourceRevision: null }));
    const state = recorded(await resolve(noProbe(), d, { sourceType: 'storefront' }));
    expect(state.source).toEqual({ kind: 'non-git' });
  });

  it('keeps a revision the platform did record, whatever the project source', async () => {
    const state = recorded(await resolve(noProbe(), deps(record()), { sourceType: 'none' }));
    expect(state.source).toEqual({ kind: 'revision', revision: SHA });
  });

  it('reports a source probe against an unrecorded revision as uncompared', async () => {
    const state = recorded(await resolve(declared(), deps(record({ sourceRevision: null }))));
    expect(state.probes?.[0]).toMatchObject({ status: 'uncompared', observed: SHA });
    expect(state.evidence).toBe('deployment-record');
  });
});

describe('state from the latest record', () => {
  it.each([
    ['queued', 'deploying'],
    ['running', 'deploying'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['succeeded', 'deployed'],
  ] as const)('reads %s as %s', async (status, state) => {
    expect(recorded(await resolve(noProbe(), deps(record({ status })))).state).toBe(state);
  });

  it('probes an environment still deploying, so a mismatch says the old build still serves', async () => {
    const d = deps(record({ status: 'running' }), answering({ sourceCommit: OTHER }));
    const state = recorded(await resolve(declared(), d));
    expect(state.state).toBe('deploying');
    expect(state.evidence).toBe('runtime-mismatch');
  });
});

describe('unknown carries its reason', () => {
  it('external: nothing is read', async () => {
    const d = deps(record());
    const lookup = vi.spyOn(d, 'deployAdapterFor');
    const state = unknownOf(await resolve(declared({ deployment: { mode: 'external' } }), d));
    expect(state).toEqual({
      environment: 'dev',
      state: 'unknown',
      evidence: 'none',
      reason: { cause: 'external', message: expect.stringContaining('outside Forge') },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('no-record: the platform holds no deployment of the target', async () => {
    expect(unknownOf(await resolve(declared(), deps(null))).reason.cause).toBe('no-record');
  });

  it('adapter-error: the platform refusal is named, not thrown', async () => {
    const d = deps(new Error('Coolify deployment d1: status "paused" is not one Forge maps'));
    expect(unknownOf(await resolve(declared(), d)).reason).toEqual({
      cause: 'adapter-error',
      message: 'Coolify deployment d1: status "paused" is not one Forge maps',
    });
  });

  it('binding-refused: a binding the project does not hold is named', async () => {
    const other = declared({
      deployment: { binding: '00000000-0000-4000-8000-000000000000', trigger: 'on-land' },
    });
    const reason = unknownOf(await resolve(other, deps(record()))).reason;
    expect(reason.cause).toBe('binding-refused');
    expect(reason.message).toMatch(/^BINDING_NOT_FOUND: .*00000000-0000-4000-8000-000000000000/);
  });

  it('binding-refused: a lookup refusal carries its code', async () => {
    const d = {
      ...deps(record()),
      deployAdapterFor: async () => {
        throw new EnvironmentStateError(
          'DEPLOY_HISTORY_UNSUPPORTED',
          'binding x cannot read history',
        );
      },
    };
    expect(unknownOf(await resolve(declared(), d)).reason).toEqual({
      cause: 'binding-refused',
      message: 'DEPLOY_HISTORY_UNSUPPORTED: binding x cannot read history',
    });
  });

  it('adapter-error: a lookup that fails for any other reason', async () => {
    const d = {
      ...deps(record()),
      deployAdapterFor: async () => {
        throw new Error('vault unreadable');
      },
    };
    expect(unknownOf(await resolve(declared(), d)).reason).toEqual({
      cause: 'adapter-error',
      message: 'vault unreadable',
    });
  });
});

describe('the answer is the schema', () => {
  it('refuses a record the state schema cannot represent', async () => {
    await expect(resolve(declared(), deps(record({ sourceRevision: 'main' })))).rejects.toThrow(
      /revision/,
    );
  });
});
