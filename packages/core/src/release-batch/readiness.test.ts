// What settings can say before the first issue runs.
//
// The value of this module is entirely in the NEGATIVE cases: a gap it fails
// to report is a fact that arrives hours later, in a job, which is the whole
// thing it exists to prevent. So every test below asserts a specific gap key
// is present, never merely that `gaps` is non-empty.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROD_BINDING,
  production,
  projectDoc,
  sourceProbe,
} from '../project-config/release-path.fixture.js';
import type { Promotion } from '../project-config/release-path.js';
import type { EnvironmentDeclaration, ProjectDocument } from '../project-config/schema.js';

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

const readDocument = vi.fn(
  async (): Promise<{ revision: number; document: ProjectDocument } | null> => null,
);
vi.mock('../project-config/service.js', () => ({
  readProjectDocument: () => readDocument(),
}));

vi.mock('../project-config/environment-state-read.js', () => ({
  readEnvironmentState: async () => {
    throw new Error('readiness reads no environment state in these cases');
  },
}));

const productionPair = vi.fn(async () => null as unknown);
vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, findBindingWithConnectionById: () => productionPair() };
});

const { loadReleaseReadiness } = await import('./readiness.js');

// The code under test asks the registry what a provider DECLARES (its rollback representability,
// its webhook header) rather than naming providers (ISS-1071). An empty registry throws rather
// than answering "no provider declares anything", which would pass these assertions while
// describing a deployment with no integrations in it.
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

const CONTRACT_KNOWLEDGE = {
  'build-commands': 'pnpm build',
  'test-commands': 'pnpm test',
};
const WITH_PROCEDURE = { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' };

const SOURCE_PROBED = production({
  verification: { runtime: [sourceProbe('https://example.test/api/health', 'commit')] },
});

function project(over: {
  facts?: Record<string, unknown>;
  repoUrl?: string | null;
  production?: EnvironmentDeclaration | null;
  others?: Record<string, EnvironmentDeclaration>;
  promotions?: Promotion[];
}) {
  // Every real project on this deployment declares a repository — the pipeline cannot check one
  // out otherwise — so the fixture declares one too. Since ISS-1048 the build/test obligations are
  // conditioned on that declaration, and a fixture silently missing it would make the contract
  // tests below pass by owing nothing at all. The repo-less case gets its own test.
  selectLimit.mockResolvedValue([
    {
      id: PROJECT_ID,
      repoUrl: over.repoUrl === undefined ? 'git@github.com:acme/app.git' : over.repoUrl,
      baseBranch: 'main',
    },
  ]);
  heldSlugs.mockResolvedValue(Object.keys(over.facts ?? CONTRACT_KNOWLEDGE));
  const environments = {
    ...(over.others ?? {}),
    ...(over.production ? { beta: over.production } : {}),
  };
  readDocument.mockResolvedValue({
    revision: 1,
    document: projectDoc({ environments, promotions: over.promotions ?? [] }),
  });
}

function liveBinding(config: Record<string, unknown> = {}) {
  productionPair.mockResolvedValue({
    binding: {
      id: PROD_BINDING,
      projectId: PROJECT_ID,
      active: true,
      provider: 'coolify',
      config,
      instructions: null,
      label: '',
      role: 'deploy',
    },
    connection: { active: true, config: {} },
  });
}

const DECLARED = { releaseRunnerLabel: 'prod-box', rollback: { mode: 'coolify-image' } };

beforeEach(() => {
  vi.clearAllMocks();
  readDocument.mockResolvedValue(null);
  productionPair.mockResolvedValue(null);
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
  });

  it('owes no build or test commands to a project that declares no repository', async () => {
    project({ facts: {}, repoUrl: null });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).not.toContain('build-commands');
    expect(out?.gaps).not.toContain('test-commands');
  });

  it('says nothing at all when a project with no production has answered its contract', async () => {
    project({});

    await expect(loadReleaseReadiness(PROJECT_ID)).resolves.toMatchObject({
      hasReleaseGate: false,
      production: null,
      promotions: [],
      gaps: [],
    });
  });

  it('names every release gap at once on a project that does declare a release', async () => {
    const promotions = [{ from: 'main', to: 'production', via: 'merge' as const }];
    project({ production: production({ deploysFrom: 'production' }), promotions });
    liveBinding();

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(true);
    expect(out?.gaps.sort()).toEqual(['release-procedure', 'rollback', 'verify-probes']);
    expect(out?.defaultBranch).toBe('main');
    expect(out?.promotions).toEqual(promotions);
    expect(out?.production).toEqual({
      environment: 'beta',
      deploysFrom: 'production',
      bindingId: PROD_BINDING,
      trigger: 'on-request',
    });
  });

  it('drops each release gap as its half is declared', async () => {
    project({ production: SOURCE_PROBED, facts: WITH_PROCEDURE });
    liveBinding(DECLARED);

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual([]);
    expect(out?.releaseRunnerLabel).toBe('prod-box');
    expect(out?.rollbackMode).toBe('coolify-image');
    expect(out?.rollback).toBeNull();
  });

  it('names the binding still declaring a coolify rollback as free text', async () => {
    project({ production: SOURCE_PROBED, facts: WITH_PROCEDURE });
    liveBinding({ releaseRunnerLabel: 'prod-box', rollback: 'redeploy the previous tag' });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual(['rollback-prose']);
    expect(out?.rollbackMode).toBe('unrepresentable');
    expect(out?.rollback).toBe('redeploy the previous tag');
  });

  it('reports no release gaps for a project with no production however many bindings it has', async () => {
    project({
      others: { dev: { tier: 'dev', deployment: { binding: PROD_BINDING, trigger: 'on-land' } } },
    });
    liveBinding({});

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(false);
    expect(out?.providers).toEqual([]);
    expect(out?.gaps).not.toContain('release-procedure');
    expect(out?.releaseRunnerLabel).toBeNull();
  });

  it('reports the release gaps of a project whose production deploys in place', async () => {
    project({ production: production() });
    liveBinding({ releaseRunnerLabel: 'epod-prod' });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(true);
    expect(out?.providers).toEqual(['coolify']);
    expect(out?.promotions).toEqual([]);
    expect(out?.gaps).toContain('release-procedure');
    expect(out?.gaps).toContain('rollback');
    expect(out?.gaps).not.toContain('release-runner');
    expect(out?.hasVerify).toBe(false);
  });

  it('names a declared release with nowhere to land as its own gap, with its reason', async () => {
    project({ production: production() });

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.hasReleaseGate).toBe(false);
    expect(out?.targetUndeclared).toBe(true);
    expect(out?.targetUndeclaredReason).toMatch(/not an active binding of this project/);
    expect(out?.gaps).toContain('release-target');
  });

  it('names the undeclared probes of a releasing project as their own gap', async () => {
    project({ production: production() });
    liveBinding(DECLARED);

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toContain('verify-probes');
    expect(out?.hasVerify).toBe(false);
    // ISS-1321: the absence is reported, and is no reason a release will not start.
    expect(out?.blockers.filter((b) => b.code.startsWith('RELEASE_PROBES'))).toEqual([]);
  });
});

describe('loadReleaseReadiness — the probes production declares', () => {
  it('reports no probe gap once production declares a source probe', async () => {
    project({ production: SOURCE_PROBED });
    liveBinding(DECLARED);

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).not.toContain('verify-probes');
    expect(out?.hasVerify).toBe(true);
    expect(out?.verifySources).toEqual(['environment']);
  });

  it('reports the probe gap, and refuses the release, where every probe identifies an artifact', async () => {
    project({
      production: production({
        verification: {
          runtime: [
            { type: 'http', url: 'https://cdn.test/build', path: 'digest', identifies: 'artifact' },
          ],
        },
      }),
    });
    liveBinding(DECLARED);

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toContain('verify-probes');
    expect(out?.verifySources).toEqual(['declared-unusable']);
    expect(out?.blockers.map((b) => b.code)).toContain('RELEASE_PROBES_UNREADABLE');
  });
});

/**
 * ISS-1069 — an absent preview is no gap at all. Two projects identical but for a preview
 * environment must return the same gaps, which is a claim no single-project assertion can make.
 */
describe('loadReleaseReadiness — the preview that is not a gap', () => {
  it('reports the SAME gaps with and without a preview environment', async () => {
    project({ production: SOURCE_PROBED, facts: WITH_PROCEDURE });
    liveBinding(DECLARED);
    const withoutPreview = await loadReleaseReadiness(PROJECT_ID);

    project({
      production: SOURCE_PROBED,
      facts: WITH_PROCEDURE,
      others: {
        stg: {
          tier: 'preview',
          deployment: { mode: 'external' },
          url: 'https://stg.example.test',
          services: { mailbox: 'https://mail.example.test' },
        },
      },
    });
    liveBinding(DECLARED);
    const withPreview = await loadReleaseReadiness(PROJECT_ID);

    expect(withoutPreview?.gaps).toEqual(withPreview?.gaps);
    expect(withoutPreview?.gaps).toEqual([]);
  });

  it('reports no gap whose key is about a preview, on any project', async () => {
    project({ production: production() });
    liveBinding({});

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps.filter((g) => /preview|staging/i.test(g))).toEqual([]);
  });
});
