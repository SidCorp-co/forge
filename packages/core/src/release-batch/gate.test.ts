// The gate answer is read by two very different callers: the batch service,
// where `null` only hides an action, and the close rewrite, where a non-null
// answer BLOCKS an agent from ever closing an issue. These tests pin the
// asymmetry that follows from that, and the AND that ISS-897 made the rule.

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
  return { ...actual, listActiveBindingsForEnvironment: () => listBindings() };
});

const { resolveProductionDeclaration, resolveReleaseGate } = await import('./gate.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

const project = (baseBranch: string | null, productionBranch: string | null) => [
  { baseBranch, productionBranch },
];
const prodBinding = (provider = 'coolify') => [{ binding: { provider }, connection: {} }];

beforeEach(() => {
  vi.clearAllMocks();
  listBindings.mockResolvedValue([]);
  selectLimit.mockResolvedValue([]);
});

describe('resolveReleaseGate', () => {
  it('gives the gate to a project with a prod binding AND a distinct production branch', async () => {
    selectLimit.mockResolvedValue(project('dev', 'master'));
    listBindings.mockResolvedValue(prodBinding());
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBe('released');
  });

  // cm:guard the AND is the whole rule, and each half is here because a live project fails on exactly that half. forge-dev carries two active prod bindings (sentry, epodsystem) on a trunk repo — they are observability, not a release target, and it deliberately has no gate. epodsystem-core promotes dev->master with no binding at all — it has nowhere to send a release and rule 3 puts the release runner ON that binding, so a gate there could never pick a box.
  it('refuses the gate when either half is missing', async () => {
    selectLimit.mockResolvedValue(project('main', 'main'));
    listBindings.mockResolvedValue(prodBinding('sentry'));
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();

    selectLimit.mockResolvedValue(project('dev', 'master'));
    listBindings.mockResolvedValue([]);
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();
  });

  it('is null for a project that does not exist, never a gate', async () => {
    selectLimit.mockResolvedValue([]);
    listBindings.mockResolvedValue(prodBinding());
    await expect(resolveReleaseGate(PROJECT_ID)).resolves.toBeNull();
  });

  // cm:guard a null branch column must read as `main`, not as "different from the other null". Two nulls collapsing to one default is what keeps a project that never set its branches out of the gate.
  it('reads absent branch columns as main, so an unconfigured project has no production', async () => {
    selectLimit.mockResolvedValue(project(null, null));
    listBindings.mockResolvedValue(prodBinding());
    const decl = await resolveProductionDeclaration(PROJECT_ID);
    expect(decl).toEqual({
      hasProduction: false,
      baseBranch: 'main',
      productionBranch: 'main',
      provider: 'coolify',
    });
  });

  it('reports the provider even where there is no gate, so settings can say which half is missing', async () => {
    selectLimit.mockResolvedValue(project('main', 'main'));
    listBindings.mockResolvedValue(prodBinding('epodsystem'));
    const decl = await resolveProductionDeclaration(PROJECT_ID);
    expect(decl?.provider).toBe('epodsystem');
    expect(decl?.hasProduction).toBe(false);
  });
});
