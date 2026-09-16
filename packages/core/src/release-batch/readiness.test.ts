// What settings can say before the first issue runs.
//
// The value of this module is entirely in the NEGATIVE cases: a gap it fails
// to report is a fact that arrives hours later, in a job, which is the whole
// thing it exists to prevent. So every test below asserts a specific gap key
// is present, never merely that `gaps` is non-empty.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listBindings = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }) },
}));

vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, listActiveDeployBindingsForStage: () => listBindings() };
});

const { loadReleaseReadiness } = await import('./readiness.js');

const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

const CONTRACT_FACTS = {
  'build-commands': 'pnpm build',
  'test-commands': 'pnpm test',
};

function project(over: {
  baseBranch?: string;
  liveBranch?: string | null;
  releaseModel?: 'none' | 'promote' | 'publish';
  releaseStrategy?: string | null;
  facts?: Record<string, unknown>;
}) {
  const row = {
    baseBranch: over.baseBranch ?? 'main',
    liveBranch: over.liveBranch === undefined ? null : over.liveBranch,
    releaseModel: over.releaseModel ?? 'none',
    releaseStrategy: over.releaseStrategy ?? null,
    agentConfig: { projectFacts: over.facts ?? CONTRACT_FACTS },
  };
  selectLimit.mockResolvedValue([row]);
}

const PROBES = { probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }] };

function liveBinding(config: Record<string, unknown> = {}) {
  listBindings.mockResolvedValue([
    {
      binding: {
        id: 'b-1',
        provider: 'coolify',
        config,
        instructions: null,
        label: '',
        role: 'deploy',
        stages: ['live'],
      },
      connection: { config: {} },
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  listBindings.mockResolvedValue([]);
  selectLimit.mockResolvedValue([]);
});

describe('loadReleaseReadiness', () => {
  it('is null for a project that does not exist, rather than a contract nobody owes', async () => {
    await expect(loadReleaseReadiness(PROJECT_ID)).resolves.toBeNull();
  });

  it('reports the contract gaps on a project with no release step at all', async () => {
    project({ facts: {} });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(false);
    expect(out?.gaps).toEqual(expect.arrayContaining(['build-commands', 'test-commands']));
    expect(out?.gaps).not.toContain('release-procedure');
    expect(out?.gaps).not.toContain('release-runner');
  });

  it('says nothing at all when a none project has answered its contract', async () => {
    project({});

    await expect(loadReleaseReadiness(PROJECT_ID)).resolves.toMatchObject({
      hasReleaseGate: false,
      gaps: [],
    });
  });

  it('names every release gap at once on a project that does declare a release', async () => {
    project({ releaseModel: 'promote', liveBranch: 'production', releaseStrategy: 'merge-branch' });
    liveBinding();

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(true);
    expect(out?.gaps.sort()).toEqual([
      'release-procedure',
      'release-runner',
      'rollback',
      'verify-probes',
    ]);
  });

  it('drops each release gap as its half is declared', async () => {
    project({
      releaseModel: 'promote',
      liveBranch: 'production',
      releaseStrategy: 'merge-branch',
      facts: { ...CONTRACT_FACTS, 'release-procedure': 'cut a tag, then deploy' },
    });
    liveBinding({
      releaseRunnerLabel: 'prod-box',
      verify: PROBES,
      rollback: { mode: 'coolify-image' },
    });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual([]);
    expect(out?.releaseRunnerLabel).toBe('prod-box');
    expect(out?.rollbackMode).toBe('coolify-image');
    expect(out?.rollback).toBeNull();
  });

  it('names the binding still declaring a coolify rollback as free text', async () => {
    project({
      releaseModel: 'promote',
      liveBranch: 'production',
      releaseStrategy: 'merge-branch',
      facts: { ...CONTRACT_FACTS, 'release-procedure': 'cut a tag, then deploy' },
    });
    liveBinding({
      releaseRunnerLabel: 'prod-box',
      verify: PROBES,
      rollback: 'redeploy the previous tag',
    });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual(['rollback-prose']);
    expect(out?.rollbackMode).toBe('unrepresentable');
    expect(out?.rollback).toBe('redeploy the previous tag');
  });

  it('reports no release gaps for a none project however many bindings it has', async () => {
    project({});
    liveBinding({});

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(false);
    expect(out?.providers).toEqual([]);
    expect(out?.gaps).not.toContain('release-procedure');
    expect(out?.releaseRunnerLabel).toBeNull();
  });

  it('reports the release gaps of a publish project', async () => {
    project({ releaseModel: 'publish' });
    liveBinding({ releaseRunnerLabel: 'epod-prod' });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(true);
    expect(out?.providers).toEqual(['coolify']);
    expect(out?.gaps).toContain('release-procedure');
    expect(out?.gaps).toContain('rollback');
    expect(out?.gaps).not.toContain('release-runner');
    expect(out?.hasVerify).toBe(false);
  });

  it('names a declared release with nowhere to land as its own gap', async () => {
    project({ releaseModel: 'publish' });
    listBindings.mockResolvedValue([]);

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(false);
    expect(out?.targetUndeclared).toBe(true);
    expect(out?.gaps).toContain('release-target');
  });

  it('reports disagreeing runner labels as a gap rather than throwing', async () => {
    project({ releaseModel: 'publish' });
    listBindings.mockResolvedValue([
      {
        binding: {
          id: 'b-1',
          provider: 'coolify',
          config: { releaseRunnerLabel: 'release' },
          instructions: null,
          label: '',
          role: 'deploy',
          stages: ['live'],
        },
        connection: { config: {} },
      },
      {
        binding: {
          id: 'b-2',
          provider: 'epodsystem',
          config: { releaseRunnerLabel: 'epod-prod' },
          instructions: null,
          label: '',
          role: 'deploy',
          stages: ['live'],
        },
        connection: { config: {} },
      },
    ]);

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toContain('release-runner-ambiguous');
    expect(out?.releaseRunnerLabel).toBeNull();
  });

  it('names the undeclared probes of a releasing project as their own gap', async () => {
    project({ releaseModel: 'promote', liveBranch: 'production', releaseStrategy: 'merge-branch' });
    liveBinding({ releaseRunnerLabel: 'prod-box', rollback: { mode: 'coolify-image' } });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toContain('verify-probes');
    expect(out?.hasVerify).toBe(false);
  });
});

describe('loadReleaseReadiness — more than one live channel', () => {
  it('names two live channels as their own gap, even where nothing else is missing', async () => {
    project({
      releaseModel: 'publish',
      facts: { ...CONTRACT_FACTS, 'release-procedure': 'ship it' },
    });
    listBindings.mockResolvedValue(
      ['b-1', 'b-2'].map((id) => ({
        binding: {
          id,
          provider: 'coolify',
          config: {
            releaseRunnerLabel: 'prod-box',
            verify: PROBES,
            rollback: { mode: 'coolify-image' },
          },
          instructions: null,
          label: id,
          role: 'deploy',
          stages: ['live'],
        },
        connection: { config: {} },
      })),
    );

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual(['release-multi-channel']);
    expect(out?.releaseRunnerLabel).toBe('prod-box');
  });

  it('reports no multi-channel gap for the one-channel projects the fleet actually has', async () => {
    project({
      releaseModel: 'publish',
      facts: { ...CONTRACT_FACTS, 'release-procedure': 'ship it' },
    });
    liveBinding({
      releaseRunnerLabel: 'prod-box',
      verify: PROBES,
      rollback: { mode: 'coolify-image' },
    });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual([]);
  });
});

describe('loadReleaseReadiness — the declared probes', () => {
  it('reports no probe gap once the binding declares them', async () => {
    project({ releaseModel: 'promote', liveBranch: 'production', releaseStrategy: 'merge-branch' });
    liveBinding({
      releaseRunnerLabel: 'prod-box',
      verify: PROBES,
      rollback: { mode: 'coolify-image' },
    });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).not.toContain('verify-probes');
    expect(out?.hasVerify).toBe(true);
  });
});
