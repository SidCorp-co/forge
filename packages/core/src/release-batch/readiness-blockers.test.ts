/**
 * What would REFUSE a release now, as `release-readiness` answers it. Split from
 * `readiness.test.ts`, which is about what settings can SAY (ISS-1127).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listBindings = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);
// The enumerator reads the roster with a query that ENDS at `where()`, and the
// runner pool with `db.execute`, so the mock has to answer both.
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

// The two reproductions: `gaps: []` beside a create that still refuses, and a
// reason that cannot be evaluated taking the whole answer with it.
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

  it('answers with the reason it could not evaluate BESIDE every reason it could', async () => {
    project({ ...RELEASING, environments: LIVE_DECLARED });
    listBindings.mockRejectedValue(new Error('binding store unreachable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    // Each check below takes a project id alone, so a failed declaration may not drop it.
    expect(out?.blockers.map((b) => b.code)).toEqual([
      'RELEASE_CHECK_UNEVALUATED',
      'RELEASE_ROSTER_EMPTY',
      'RELEASE_CHECK_UNEVALUATED',
      'RELEASE_POOL_EMPTY',
    ]);
    expect(out?.blockers[0]?.details).toMatchObject({ check: 'declaration' });
    expect(out?.blockers[2]?.details).toMatchObject({ check: 'channels' });
  });
});

// `declarationRead` stops fallback fields reading as a confirmed absence.
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

// A gap is an absence somebody can act on, never a read nobody managed to make.
describe('loadReleaseReadiness — a gap is never inferred from a read that failed', () => {
  const RELEASING = {
    releaseModel: 'promote' as const,
    liveBranch: 'production',
    releaseStrategy: 'merge-branch',
    facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' },
  };

  it('reports no channel gap where the channels could not be read', async () => {
    project({ ...RELEASING, environments: LIVE_DECLARED });
    liveBinding({
      releaseRunnerLabel: 'prod-box',
      verify: PROBES,
      rollback: { mode: 'coolify-image' },
    });
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
