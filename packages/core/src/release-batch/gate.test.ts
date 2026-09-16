// The gate answer is read by two very different callers: the batch service, where
// `null` only hides an action, and the close rewrite, where a non-null answer
// BLOCKS an agent from ever closing an issue. These tests pin the asymmetry that
// follows, and the rule ISS-1046 put in place of the inference ISS-897 left.
//
// Every case below is a real fleet project, named, because the previous rule
// passed every test it had and still handed a Sentry project to a release agent.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listBindings = vi.fn(async () => [] as unknown[]);
const selectLimit = vi.fn(async () => [] as unknown[]);

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  },
}));

vi.mock('../integrations/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../integrations/store.js')>();
  return { ...actual, listActiveDeployBindingsForStage: () => listBindings() };
});

const { ReleaseTargetUndeclaredError, resolveReleaseDeclaration, resolveReleaseGate } =
  await import('./gate.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

const project = (
  releaseModel: 'none' | 'promote' | 'publish',
  over: {
    baseBranch?: string | null;
    liveBranch?: string | null;
    releaseStrategy?: string | null;
  } = {},
) => [
  {
    baseBranch: over.baseBranch ?? 'main',
    liveBranch: over.liveBranch ?? null,
    releaseModel,
    releaseStrategy: over.releaseStrategy ?? null,
  },
];

const liveBinding = (provider = 'coolify', config: Record<string, unknown> = {}) => [
  { binding: { provider, config, role: 'deploy', stages: ['live'] }, connection: {} },
];

beforeEach(() => {
  vi.clearAllMocks();
  listBindings.mockResolvedValue([]);
  selectLimit.mockResolvedValue([]);
});

describe('resolveReleaseGate', () => {
  it('gives the gate to a promote project with a live deploy binding', async () => {
    selectLimit.mockResolvedValue(
      project('promote', {
        baseBranch: 'staging',
        liveBranch: 'master',
        releaseStrategy: 'merge-branch',
      }),
    );
    listBindings.mockResolvedValue(liveBinding());
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBe('awaiting_release');
  });

  // cm:guard butlocs, mowment and pixelight are the reason this case exists separately from `promote`.
  // A theme publish IS the release: base and live are the same ref by nature, so the branch comparison
  // the old gate rested on could not see them and the `||` that rescued pixelight rested on a runner
  // label the other two never set. Under the declared model all three are simply `publish`.
  it('gives the gate to a publish project with a live deploy binding, with no branch involved', async () => {
    selectLimit.mockResolvedValue(project('publish', { baseBranch: 'main', liveBranch: null }));
    listBindings.mockResolvedValue(liveBinding('epodsystem'));
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBe('awaiting_release');
  });

  // cm:guard the regression the old `||` caused and this rule removes. forge-dev's epodsystem binding
  // is the storefront MCP credential on a trunk repo; if provider identity, mere presence, or a
  // branch comparison granted the gate, every agent close in this repository would be rewritten.
  it('refuses the gate to a none project even with a live deploy binding', async () => {
    selectLimit.mockResolvedValue(project('none'));
    listBindings.mockResolvedValue(liveBinding('epodsystem'));
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();
  });

  // cm:guard adminhub-api, adminhub-ui, epodsystem-core, house-supabase, sidboss and sidcorp-mail all
  // carry a live branch genuinely distinct from their base and declare `none`. The old rule read the
  // branch pair and would have gated four of them the moment they gained any active prod binding.
  it('refuses the gate to a none project whose two branches differ', async () => {
    selectLimit.mockResolvedValue(
      project('none', { baseBranch: 'release/stg', liveBranch: 'release/production' }),
    );
    listBindings.mockResolvedValue(liveBinding());
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();
  });

  it('is null for a project that does not exist, never a gate', async () => {
    selectLimit.mockResolvedValue([]);
    listBindings.mockResolvedValue(liveBinding());
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();
  });
});

describe('a release model with nothing to release onto', () => {
  // cm:guard REFUSED BY NAME and not answered `null`. Both shapes answered `null` before ISS-1046,
  // so "this project ships nothing" and "this project says it ships and has nowhere to ship to" were
  // the same answer — which is how dodgeprint-api parked every issue at `awaiting_release` behind a
  // Sentry binding for as long as it did.
  it('throws RELEASE_TARGET_UNDECLARED when the project has no live deploy binding at all', async () => {
    selectLimit.mockResolvedValue(
      project('promote', { liveBranch: 'master', releaseStrategy: 'merge-branch' }),
    );
    listBindings.mockResolvedValue([]);
    await expect(resolveReleaseGate(PROJECT_ID)).rejects.toThrow(ReleaseTargetUndeclaredError);
    await expect(resolveReleaseGate(PROJECT_ID)).rejects.toThrow(/RELEASE_TARGET_UNDECLARED/);
  });

  // cm:guard `listActiveDeployBindingsForStage` filters inactive bindings and inactive connections, so
  // a project whose ONLY live binding was switched off is this case and not the gated one. archmap and
  // forge-dev each carry an inactive coolify binding today, which is why the distinction is real.
  it('throws the same named error when the only live deploy binding is inactive', async () => {
    selectLimit.mockResolvedValue(project('publish'));
    listBindings.mockResolvedValue([]);
    await expect(resolveReleaseGate(PROJECT_ID)).rejects.toThrow(/RELEASE_TARGET_UNDECLARED/);
  });

  it('names the project and the model in the message, so an operator knows which half to fix', async () => {
    selectLimit.mockResolvedValue(project('publish'));
    listBindings.mockResolvedValue([]);
    await expect(resolveReleaseGate(PROJECT_ID)).rejects.toThrow(
      new RegExp(`${PROJECT_ID}[\\s\\S]*publish`),
    );
  });
});

describe('resolveReleaseDeclaration', () => {
  it('returns the whole live set, not its first member', async () => {
    selectLimit.mockResolvedValue(
      project('promote', { liveBranch: 'master', releaseStrategy: 'merge-branch' }),
    );
    listBindings.mockResolvedValue([
      {
        binding: { provider: 'coolify', config: {}, role: 'deploy', stages: ['live'] },
        connection: {},
      },
      {
        binding: { provider: 'epodsystem', config: {}, role: 'deploy', stages: ['live'] },
        connection: {},
      },
    ]);
    const decl = await resolveReleaseDeclaration(PROJECT_ID);
    expect(decl?.kind).toBe('gated');
    expect(decl?.kind === 'gated' && decl.liveBindings).toHaveLength(2);
  });

  it('carries the declared strategy through for a promote project', async () => {
    selectLimit.mockResolvedValue(
      project('promote', { liveBranch: 'master', releaseStrategy: 'cherry-pick' }),
    );
    listBindings.mockResolvedValue(liveBinding());
    const decl = await resolveReleaseDeclaration(PROJECT_ID);
    expect(decl?.kind === 'gated' && decl.releaseStrategy).toBe('cherry-pick');
  });

  // cm:guard a `none` project short-circuits BEFORE the binding query. It is not an optimisation: it
  // is what makes the model the only input, so a `none` project cannot acquire a gate by acquiring a
  // binding, which is precisely what happened to getcontent when its coolify box was labelled staging.
  it('answers no-release for a none project without reading its bindings at all', async () => {
    selectLimit.mockResolvedValue(project('none'));
    const decl = await resolveReleaseDeclaration(PROJECT_ID);
    expect(decl).toEqual({ kind: 'no-release', releaseModel: 'none', baseBranch: 'main' });
    expect(listBindings).not.toHaveBeenCalled();
  });
});
