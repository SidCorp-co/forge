/**
 * What would REFUSE a release now, as `release-readiness` answers it. Split from
 * `readiness.test.ts`, which is about what settings can SAY (ISS-1127).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROD_BINDING,
  production,
  projectDoc,
  sourceProbe,
} from '../project-config/release-path.fixture.js';
import type { ProjectDocument } from '../project-config/schema.js';

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

// The code under test asks the registry what a provider DECLARES rather than naming providers
// (ISS-1071). An empty registry throws rather than answering "no provider declares anything",
// which would pass these assertions while describing a deployment with no integrations in it.
const { registerAllIntegrations } = await import('../integrations/register-all.js');
registerAllIntegrations();

const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

const CONTRACT_KNOWLEDGE = {
  'build-commands': 'pnpm build',
  'test-commands': 'pnpm test',
};

const SOURCE_PROBED = production({
  verification: { runtime: [sourceProbe('https://example.test/api/health', 'commit')] },
});

function project(over: { facts?: Record<string, unknown>; releasing?: boolean }) {
  // Every real project declares a repository — the pipeline cannot check one out otherwise — so
  // the fixture does too: the build/test obligations hang off that declaration, and a fixture
  // missing it would pass by owing nothing. The repo-less case is its own test.
  selectLimit.mockResolvedValue([{ id: PROJECT_ID, repoPath: '/srv/app', baseBranch: 'main' }]);
  heldSlugs.mockResolvedValue(Object.keys(over.facts ?? CONTRACT_KNOWLEDGE));
  readDocument.mockResolvedValue({
    revision: 1,
    document: projectDoc({ environments: over.releasing ? { beta: SOURCE_PROBED } : {} }),
  });
}

function pairOf(config: Record<string, unknown>) {
  const { rollback, ...bindingConfig } = config;
  return {
    binding: {
      id: PROD_BINDING,
      projectId: PROJECT_ID,
      active: true,
      provider: 'coolify',
      config: bindingConfig,
      instructions: null,
      label: '',
      role: 'deploy',
    },
    connection: { active: true, config: rollback === undefined ? {} : { rollback } },
  };
}

function liveBinding(config: Record<string, unknown> = {}) {
  productionPair.mockResolvedValue(pairOf(config));
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

// The two reproductions: `gaps: []` beside a create that still refuses, and a
// reason that cannot be evaluated taking the whole answer with it.
describe('loadReleaseReadiness — every reason at once (ISS-1127)', () => {
  const RELEASING = {
    releasing: true,
    facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' },
  };

  it('names the roster and fleet refusals a create would make, not only the declarations', async () => {
    project(RELEASING);
    liveBinding(DECLARED);

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).toEqual([]);
    expect(out?.blockers.map((b) => b.code)).toContain('RELEASE_POOL_EMPTY');
  });

  it('answers with the reason it could not evaluate BESIDE every reason it could', async () => {
    project(RELEASING);
    productionPair.mockRejectedValue(new Error('binding store unreachable'));

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
    project({ releasing: true });
    selectLimit.mockRejectedValue(new Error('projects table unreadable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.declarationRead).toBe(false);
    // The channel is the production binding the declaration names, so it is unread with it.
    expect(out?.blockers.map((b) => [b.code, b.details?.check])).toEqual([
      ['RELEASE_CHECK_UNEVALUATED', 'declaration'],
      ['RELEASE_ROSTER_EMPTY', undefined],
      ['RELEASE_CHECK_UNEVALUATED', 'channels'],
      ['RELEASE_POOL_EMPTY', undefined],
    ]);
  });

  it('says the repository was not read, and owes nothing on it, where the document cannot be read', async () => {
    project({ facts: {} });
    readDocument.mockRejectedValue(new Error('project document unreadable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.blockers.map((b) => [b.code, b.details?.check])).toContainEqual([
      'RELEASE_CHECK_UNEVALUATED',
      'repository',
    ]);
    expect(out?.gaps).not.toContain('build-commands');
  });

  it('says it WAS read for every project whose declaration answered', async () => {
    project({});

    expect((await loadReleaseReadiness(PROJECT_ID))?.declarationRead).toBe(true);
  });
});

// A gap is an absence somebody can act on, never a read nobody managed to make.
describe('loadReleaseReadiness — a gap is never inferred from a read that failed', () => {
  const RELEASING = {
    releasing: true,
    facts: { ...CONTRACT_KNOWLEDGE, 'release-procedure': 'cut a tag, then deploy' },
  };

  it('reports no channel gap where the channels could not be read', async () => {
    project(RELEASING);
    liveBinding(DECLARED);
    productionPair.mockReset();
    productionPair.mockResolvedValueOnce(pairOf(DECLARED));
    productionPair.mockRejectedValue(new Error('binding store unreachable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.channelsRead).toBe(false);
    expect(out?.gaps).not.toContain('verify-probes');
    expect(out?.gaps).not.toContain('rollback');
  });

  it('reports no knowledge gap where the project row could not be read', async () => {
    project(RELEASING);
    selectLimit.mockRejectedValue(new Error('projects table unreadable'));

    const out = await loadReleaseReadiness(PROJECT_ID);

    expect(out?.gaps).not.toContain('build-commands');
    expect(out?.gaps).not.toContain('test-commands');
  });
});

// The second sentence ISS-1127 was reopened on: it named the merge, which
// eleven waiting issues had, and not the status move, which none of them had.
describe('what readiness says about an empty roster', () => {
  it('names the status move rather than the merge', async () => {
    project({ releasing: true });
    liveBinding({ releaseRunnerLabel: 'box', rollback: { mode: 'coolify-image' } });

    const answer = await loadReleaseReadiness(PROJECT_ID);
    const empty = answer?.blockers.find((b) => b.code === 'RELEASE_ROSTER_EMPTY');

    expect(empty?.message).toContain('`awaiting_release`');
    expect(empty?.message).not.toContain('merged and marked');
  });
});
