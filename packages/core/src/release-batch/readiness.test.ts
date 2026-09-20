// What settings can say before the first issue runs.
//
// The value of this module is entirely in the NEGATIVE cases: a gap it fails
// to report is a fact that arrives hours later, in a job, which is the whole
// thing it exists to prevent. So every test below asserts a specific gap key
// is present, never merely that `gaps` is non-empty.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listBindings = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
// ISS-1127 — the enumerator this answer is now built on reads the roster with a
// query that ENDS at `where()`, and the runner pool with `db.execute`. A `where`
// that only carried `.limit` made every one of these fail on `rows.map is not a
// function`, which is a mock too narrow rather than a readiness that is wrong.
const selectRows = vi.fn(async () => [] as unknown[]);
const execRows = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Object.assign(selectRows(), { limit: selectLimit }),
      }),
    }),
    execute: () => execRows(),
  },
}));

vi.mock('../runners/select.js', () => ({ onlineCapableDeviceIds: async () => [] }));

const heldSlugs = vi.fn(async (_id: string): Promise<string[]> => Object.keys(CONTRACT_KNOWLEDGE));
vi.mock('../knowledge/service.js', () => ({
  selectAllSlugsFromKnowledge: (id: string) => heldSlugs(id),
}));

vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, listActiveDeployBindingsForStage: () => listBindings() };
});

const { loadReleaseReadiness } = await import('./readiness.js');

// `readiness.ts` asks the registry what a provider DECLARES (its release step, its rollback representability,
// its webhook header) rather than naming providers (ISS-1071). Reading an empty registry throws
// rather than answering "no provider declares anything", which is the answer that would have made
// these assertions pass while describing a deployment with no integrations in it.
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

const CONTRACT_KNOWLEDGE = {
  'build-commands': 'pnpm build',
  'test-commands': 'pnpm test',
};

function project(over: {
  baseBranch?: string;
  liveBranch?: string | null;
  releaseModel?: 'none' | 'promote' | 'publish';
  releaseStrategy?: string | null;
  facts?: Record<string, unknown>;
  repoPath?: string | null;
  environments?: unknown;
}) {
  const row = {
    // Every real project on this deployment declares a repository — the pipeline cannot check one
    // out otherwise — so the fixture declares one too. Since ISS-1048 the build/test obligations are
    // conditioned on that declaration, and a fixture silently missing it would make the contract
    // tests below pass by owing nothing at all. The repo-less case gets its own test.
    repoPath: over.repoPath === undefined ? '/srv/app' : over.repoPath,
    repoUrl: null,
    baseBranch: over.baseBranch ?? 'main',
    liveBranch: over.liveBranch === undefined ? null : over.liveBranch,
    releaseModel: over.releaseModel ?? 'none',
    releaseStrategy: over.releaseStrategy ?? null,
    agentConfig: {},
    // ISS-1069 — the default is a project that records no live address, because that is what 32 of
    // 32 projects held when the column was added. The filled case is passed in by the tests about it.
    environments: over.environments,
  };
  heldSlugs.mockResolvedValue(Object.keys(over.facts ?? CONTRACT_KNOWLEDGE));
  selectLimit.mockResolvedValue([row]);
}

const PROBES = { probes: [{ url: 'https://example.test/api/health', commitPath: 'commit' }] };

// ISS-1069 — a project that has answered every declaration now also records where it is deployed,
// so the "nothing left to report" fixtures below carry it. Without it they would assert an empty
// gap set against a project still missing one, which is the shape of a test passing for the wrong
// reason.
const LIVE_DECLARED = {
  live: { url: 'https://app.example.test', commitUrl: 'https://example.test/api/health' },
};

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
  selectRows.mockResolvedValue([]);
  execRows.mockResolvedValue([]);
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

  it('owes no build or test commands to a project that declares no repository', async () => {
    project({ facts: {}, repoPath: null });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).not.toContain('build-commands');
    expect(out?.gaps).not.toContain('test-commands');
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
      'live-commit-endpoint',
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
      facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' },
      environments: LIVE_DECLARED,
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
      facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' },
      environments: LIVE_DECLARED,
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
      facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'ship it' },
      environments: LIVE_DECLARED,
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
      facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'ship it' },
      environments: LIVE_DECLARED,
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

/**
 * ISS-1069 — the live address is its own gap, and an absent preview is no gap at all.
 *
 * The second half is the one that deletes a rule rather than adding one. Nothing in this module
 * ever reported a missing staging URL; the only sentence in the tree that called an absent preview
 * a lack was guide prose. So the property to hold is an EQUALITY: two projects identical but for
 * their preview side must return the same gaps, which is a claim no single-project assertion can
 * make.
 */
describe('loadReleaseReadiness — the live address, and the preview that is not a gap', () => {
  const RELEASING = {
    releaseModel: 'promote' as const,
    liveBranch: 'production',
    releaseStrategy: 'merge-branch',
    facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' },
  };
  const DECLARED = {
    releaseRunnerLabel: 'prod-box',
    verify: PROBES,
    rollback: { mode: 'coolify-image' },
  };

  it('reports the live-endpoint gap for a releasing project that records no live commit endpoint', async () => {
    project(RELEASING);
    liveBinding(DECLARED);

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toContain('live-commit-endpoint');
  });

  it('still reports the gap for a project holding a live url and no commit endpoint', async () => {
    project({ ...RELEASING, environments: { live: { url: 'https://app.example.test' } } });
    liveBinding(DECLARED);

    expect((await loadReleaseReadiness(PROJECT_ID))?.gaps).toContain('live-commit-endpoint');
  });

  it('drops the gap once the commit endpoint is recorded', async () => {
    project({ ...RELEASING, environments: LIVE_DECLARED });
    liveBinding(DECLARED);

    expect((await loadReleaseReadiness(PROJECT_ID))?.gaps).not.toContain('live-commit-endpoint');
  });

  it('reports the SAME gaps for a null preview as for a filled one', async () => {
    project({ ...RELEASING, environments: { ...LIVE_DECLARED, preview: null } });
    liveBinding(DECLARED);
    const withoutPreview = await loadReleaseReadiness(PROJECT_ID);

    project({
      ...RELEASING,
      environments: {
        ...LIVE_DECLARED,
        preview: {
          url: 'https://stg.example.test',
          apiUrl: 'https://api.stg.example.test',
          urls: [{ label: 'Mailbox', url: 'https://mail.example.test' }],
        },
      },
    });
    liveBinding(DECLARED);
    const withPreview = await loadReleaseReadiness(PROJECT_ID);

    expect(withoutPreview?.gaps).toEqual(withPreview?.gaps);
    expect(withoutPreview?.gaps).toEqual([]);
  });

  it('reports no gap whose key is about a preview, on any project', async () => {
    project(RELEASING);
    liveBinding({});

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps.filter((g) => /preview|staging/i.test(g))).toEqual([]);
  });

  it('reports where each channel got its probes', async () => {
    project({ ...RELEASING, environments: LIVE_DECLARED });
    liveBinding({ releaseRunnerLabel: 'prod-box', rollback: { mode: 'coolify-image' } });

    expect((await loadReleaseReadiness(PROJECT_ID))?.verifySources).toEqual(['environments-live']);
  });
});

// ISS-1127 — the two reproductions, planted before the enumerator existed.
//
// The first is the evening the issue was filed: `gaps: []`, and the create still
// refused, because the roster and the fleet are checked somewhere this answer has
// never looked. The second is the other direction — a reason that cannot be
// evaluated has to appear as its own answer, and today it takes the whole answer
// with it.
describe('loadReleaseReadiness — every reason at once (ISS-1127)', () => {
  const RELEASING = {
    releaseModel: 'promote' as const,
    liveBranch: 'production',
    releaseStrategy: 'merge-branch',
    facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' },
  };

  it('names the roster and fleet refusals a create would make, not only the declarations', async () => {
    project({ ...RELEASING, environments: LIVE_DECLARED });
    liveBinding({
      releaseRunnerLabel: 'prod-box',
      verify: PROBES,
      rollback: { mode: 'coolify-image' },
    });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual([]);
    expect(out?.blockers.map((b) => b.code)).toContain('RELEASE_POOL_EMPTY');
  });

  it('answers with the reason it could not evaluate rather than throwing the whole report away', async () => {
    project({ ...RELEASING, environments: LIVE_DECLARED });
    listBindings.mockRejectedValue(new Error('binding store unreachable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.blockers.map((b) => b.code)).toContain('RELEASE_CHECK_UNEVALUATED');
  });
});

// ISS-1127, from the whole-set review — F6. Answering 200 with fallback fields
// where the declaration could not be READ makes the screen say "this project
// declares no release", which is a confirmed absence standing in for an
// unreadable one. `declarationRead` is what stops a caller doing that.
describe('loadReleaseReadiness — a declaration that could not be read', () => {
  it('says the declaration was not read rather than answering as though it were', async () => {
    project({ releaseModel: 'publish' });
    selectLimit.mockRejectedValue(new Error('projects table unreadable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.declarationRead).toBe(false);
    expect(out?.blockers.map((b) => b.code)).toContain('RELEASE_CHECK_UNEVALUATED');
  });

  it('says it WAS read for every project whose declaration answered', async () => {
    project({ releaseModel: 'none' });

    expect((await loadReleaseReadiness(PROJECT_ID))?.declarationRead).toBe(true);
  });
});

// The second whole-set read's F4. `declarationGaps` inferred `release-runner`
// from `channels: []` where the channel READ had failed, so the screen showed a
// confirmed missing declaration next to a field saying it could not be read.
describe('loadReleaseReadiness — a gap is never inferred from a read that failed', () => {
  const RELEASING = {
    releaseModel: 'promote' as const,
    liveBranch: 'production',
    releaseStrategy: 'merge-branch',
    facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' },
  };

  it('reports no channel gap where the channels could not be read', async () => {
    project({ ...RELEASING, environments: LIVE_DECLARED });
    liveBinding({ releaseRunnerLabel: 'prod-box', verify: PROBES, rollback: { mode: 'coolify-image' } });
    const declared = await listBindings();
    listBindings.mockReset();
    listBindings.mockResolvedValueOnce(declared);
    listBindings.mockRejectedValue(new Error('binding store unreachable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.channelsRead).toBe(false);
    expect(out?.gaps).not.toContain('release-runner');
    expect(out?.gaps).not.toContain('verify-probes');
    expect(out?.gaps).not.toContain('rollback');
  });

  it('reports no knowledge gap where the project row could not be read', async () => {
    project({ ...RELEASING, environments: LIVE_DECLARED });
    selectLimit.mockRejectedValue(new Error('projects table unreadable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).not.toContain('build-commands');
    expect(out?.gaps).not.toContain('live-commit-endpoint');
  });
});
