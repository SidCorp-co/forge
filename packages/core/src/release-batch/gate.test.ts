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

/** A `projects` row as `resolveReleaseDeclaration` selects it: base branch plus the chain. */
const project = (
  releaseChain: { branch: string; from?: string }[],
  over: { baseBranch?: string | null } = {},
) => [{ baseBranch: over.baseBranch ?? 'main', releaseChain }];

const SHIPS_NOTHING: { branch: string; from?: string }[] = [];
const publishes = (branch = 'main') => [{ branch }];
const promotes = (live = 'master', from = 'merge-branch', base = 'main') => [
  { branch: base },
  { branch: live, from },
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
      project(promotes('master', 'merge-branch', 'staging'), { baseBranch: 'staging' }),
    );
    listBindings.mockResolvedValue(liveBinding());
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBe('awaiting_release');
  });

  it('gives the gate to a chain of one with a live deploy binding, with no branch crossed', async () => {
    selectLimit.mockResolvedValue(project(publishes(), { baseBranch: 'main' }));
    listBindings.mockResolvedValue(liveBinding('epodsystem'));
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBe('awaiting_release');
  });

  it('refuses the gate to an empty chain even with a live deploy binding', async () => {
    selectLimit.mockResolvedValue(project(SHIPS_NOTHING));
    listBindings.mockResolvedValue(liveBinding('epodsystem'));
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();
  });

  it('refuses the gate to an empty chain on a project that names a base branch', async () => {
    selectLimit.mockResolvedValue(project(SHIPS_NOTHING, { baseBranch: 'release/stg' }));
    listBindings.mockResolvedValue(liveBinding());
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();
  });

  it('is null for a project that does not exist, never a gate', async () => {
    selectLimit.mockResolvedValue([]);
    listBindings.mockResolvedValue(liveBinding());
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();
  });
});

describe('a release chain with nothing to release onto', () => {
  it('throws RELEASE_TARGET_UNDECLARED when the project has no live deploy binding at all', async () => {
    selectLimit.mockResolvedValue(project(promotes()));
    listBindings.mockResolvedValue([]);
    await expect(resolveReleaseGate(PROJECT_ID)).rejects.toThrow(ReleaseTargetUndeclaredError);
    await expect(resolveReleaseGate(PROJECT_ID)).rejects.toThrow(/RELEASE_TARGET_UNDECLARED/);
  });

  it('throws the same named error when the only live deploy binding is inactive', async () => {
    selectLimit.mockResolvedValue(project(publishes()));
    listBindings.mockResolvedValue([]);
    await expect(resolveReleaseGate(PROJECT_ID)).rejects.toThrow(/RELEASE_TARGET_UNDECLARED/);
  });

  it('names the project and the branch in the message, so an operator knows which half to fix', async () => {
    selectLimit.mockResolvedValue(project(publishes('trunk')));
    listBindings.mockResolvedValue([]);
    await expect(resolveReleaseGate(PROJECT_ID)).rejects.toThrow(
      new RegExp(`${PROJECT_ID}[\\s\\S]*trunk`),
    );
  });
});

describe('resolveReleaseDeclaration', () => {
  it('returns the whole live set, not its first member', async () => {
    selectLimit.mockResolvedValue(project(promotes()));
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

  // The declaration carries every edge. Reducing a chain to one crossing puts a per-project
  // strategy back — the spelling ADR 0003 removed — and a reader would take the last edge for
  // the whole path.
  it('carries EVERY edge of a long chain, not just the one that reaches live', async () => {
    const chain = [
      { branch: 'main' },
      { branch: 'stg', from: 'merge-branch' as const },
      { branch: 'live', from: 'cherry-pick' as const },
    ];
    selectLimit.mockResolvedValue(project(chain));
    listBindings.mockResolvedValue(liveBinding());
    const decl = await resolveReleaseDeclaration(PROJECT_ID);
    expect(decl?.kind === 'gated' && decl.releaseChain).toEqual(chain);
    expect(decl?.kind === 'gated' && decl.liveBranch).toBe('live');
  });

  it('answers no-release for an empty chain without reading its bindings at all', async () => {
    selectLimit.mockResolvedValue(project(SHIPS_NOTHING));
    const decl = await resolveReleaseDeclaration(PROJECT_ID);
    expect(decl).toEqual({ kind: 'no-release', releaseChain: [], baseBranch: 'main' });
    expect(listBindings).not.toHaveBeenCalled();
  });
});
