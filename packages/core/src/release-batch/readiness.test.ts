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
  return { ...actual, listActiveBindingsForEnvironment: () => listBindings() };
});

const { loadReleaseReadiness } = await import('./readiness.js');

const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

const CONTRACT_FACTS = {
  'build-commands': 'pnpm build',
  'test-commands': 'pnpm test',
};

function project(over: {
  baseBranch?: string;
  productionBranch?: string;
  facts?: Record<string, unknown>;
}) {
  const row = {
    baseBranch: over.baseBranch ?? 'main',
    productionBranch: over.productionBranch ?? 'main',
    agentConfig: { projectFacts: over.facts ?? CONTRACT_FACTS },
  };
  // cm:guard ONE row shape answers all three project reads this path makes (`resolveProductionDeclaration`, this module's own, and `resolveReleaseChannel`'s) — a `mockResolvedValueOnce` here would satisfy the first and leave the other two reading an empty project, which passes for the wrong reason.
  selectLimit.mockResolvedValue([row]);
}

function prodBinding(config: Record<string, unknown> = {}) {
  listBindings.mockResolvedValue([
    { binding: { provider: 'coolify', config, instructions: null }, connection: { config: {} } },
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

  // cm:guard the contract facts are owed by EVERY project, production or not — they are what the driver needs to prove its own work. Report them conditionally and a project with no production looks complete while its very first issue has nothing to run.
  it('reports the contract gaps on a project with no production at all', async () => {
    project({ facts: {} });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasProduction).toBe(false);
    expect(out?.gaps).toEqual(expect.arrayContaining(['build-commands', 'test-commands']));
    expect(out?.gaps).not.toContain('release-procedure');
    expect(out?.gaps).not.toContain('release-runner');
  });

  it('says nothing at all when a non-production project has answered its contract', async () => {
    project({});

    await expect(loadReleaseReadiness(PROJECT_ID)).resolves.toMatchObject({
      hasProduction: false,
      gaps: [],
    });
  });

  // cm:guard all three release gaps must be reported TOGETHER. An operator told only about the runner fixes that, dispatches, and discovers the missing procedure from a failed job — which is the arrival this module exists to move earlier.
  it('names every release gap at once on a project that does declare production', async () => {
    project({ productionBranch: 'production' });
    prodBinding();

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasProduction).toBe(true);
    expect(out?.gaps.sort()).toEqual(['release-procedure', 'release-runner', 'rollback']);
  });

  it('drops each release gap as its half is declared', async () => {
    project({
      productionBranch: 'production',
      facts: { ...CONTRACT_FACTS, 'release-procedure': 'cut a tag, then deploy' },
    });
    prodBinding({ releaseRunnerLabel: 'prod-box', rollback: 'redeploy the previous tag' });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual([]);
    expect(out?.releaseRunnerLabel).toBe('prod-box');
    expect(out?.rollback).toBe('redeploy the previous tag');
  });

  // cm:guard rule 3 of ISS-897 puts the release runner ON the production binding, so a project that names one without declaring production has nowhere for it to apply — and settings must still show the runner it found, or the operator cannot tell which half they are missing.
  it('reports the provider and the runner it found even where there is no gate', async () => {
    project({});
    prodBinding({ releaseRunnerLabel: 'prod-box' });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasProduction).toBe(false);
    expect(out?.provider).toBe('coolify');
    expect(out?.releaseRunnerLabel).toBe('prod-box');
  });
});
