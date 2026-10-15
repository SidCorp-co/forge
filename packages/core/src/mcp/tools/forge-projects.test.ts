/**
 * ISS-1389 — no `forge_projects` answer hands an agent the project's API key or webhook secret.
 *
 * Each case plants a row that carries both, as a service that grew a column would hand it over,
 * and reads the whole answer for either name and either value. The tool names every field it
 * answers, so a planted column stops at the tool rather than reaching the agent's session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'fk_aaaabbbbccccddddeeeeffff00001111222233334444555566667777';
const HOOK = 'whsec-planted-in-the-row-0123456789';
const PROJECT = '11111111-1111-4111-8111-111111111111';

const row = {
  id: PROJECT,
  slug: 'p-one',
  name: 'P One',
  orgId: 'o-1',
  createdBy: 'u-1',
  description: null,
  kind: 'standard',
  repoPath: null,
  workspaceSetup: null,
  baseBranch: 'main',
  releaseChain: [],
  defaultDeviceId: null,
  environments: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  apiKey: KEY,
  webhookSecret: HOOK,
};

vi.mock('../../db/client.js', () => ({ db: {} }));

vi.mock('../../projects/service.js', () => ({
  createProject: vi.fn(async () => row),
  readProjectSummary: vi.fn(async () => row),
  updateProject: vi.fn(async () => row),
  ProjectSlugTakenError: class extends Error {},
}));

vi.mock('../../projects/release-chain.js', async (importActual) => ({
  ...(await importActual<typeof import('../../projects/release-chain.js')>()),
  releaseChainGapFor: vi.fn(async () => null),
}));
vi.mock('../../projects/stranded-work.js', () => ({ strandedWorkFor: vi.fn(async () => null) }));
const writeEnvironmentsLimits = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../../projects/environments-service.js', () => ({
  writeEnvironmentsLimits: (...args: unknown[]) => writeEnvironmentsLimits(...args),
}));

vi.mock('../../lib/authz.js', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/authz.js')>()),
  effectiveProjectRole: vi.fn(async () => ({ role: 'admin', orgRole: 'owner' })),
  loadPersonalOrgId: vi.fn(async () => 'o-1'),
}));

vi.mock('./lib.js', async (importActual) => ({
  ...(await importActual<typeof import('./lib.js')>()),
  loadVisibleProjectsWithRoleForPrincipal: vi.fn(async () => [
    { ...row, memberRole: 'admin', orgRole: 'owner' },
  ]),
}));

const {
  forgeProjectsCreateTool,
  forgeProjectsGetTool,
  forgeProjectsListTool,
  forgeProjectsUpdateTool,
} = await import('./forge-projects.js');

const ctx = { principal: { kind: 'user', userId: 'u-1' } } as never;

/** The names and values of the two secrets the planted row carries, wherever they sit in `answer`. */
function secretsIn(answer: unknown): string[] {
  const text = JSON.stringify(answer);
  return ['apiKey', 'webhookSecret', KEY, HOOK].filter((held) => text.includes(held));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_projects answers carry no secret a planted row holds', () => {
  it('list', async () => {
    const answer = await forgeProjectsListTool(ctx).handler({});
    expect(answer).toMatchObject({ projects: [{ id: PROJECT, role: 'admin' }] });
    expect(secretsIn(answer)).toEqual([]);
  });

  it('get', async () => {
    const answer = await forgeProjectsGetTool(ctx).handler({ projectId: PROJECT });
    expect(answer).toMatchObject({ project: { id: PROJECT, role: 'admin' } });
    expect(secretsIn(answer)).toEqual([]);
  });

  it('create', async () => {
    const answer = await forgeProjectsCreateTool(ctx).handler({ slug: 'p-one', name: 'P One' });
    expect(answer).toMatchObject({ project: { id: PROJECT, slug: 'p-one' } });
    expect(secretsIn(answer)).toEqual([]);
  });

  it('update, writing a setting', async () => {
    const answer = await forgeProjectsUpdateTool(ctx).handler({
      projectId: PROJECT,
      patch: { name: 'P Two' },
    });
    expect(answer).toMatchObject({ project: { id: PROJECT, slug: 'p-one' } });
    expect(secretsIn(answer)).toEqual([]);
  });

  it('update, writing only the limits', async () => {
    const answer = await forgeProjectsUpdateTool(ctx).handler({
      projectId: PROJECT,
      patch: { environmentsLimits: { base: null, value: 'no billing screen' } },
    });
    expect(writeEnvironmentsLimits).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ project: { id: PROJECT, environments: null } });
    expect(secretsIn(answer)).toEqual([]);
  });

  it('the check itself finds a secret the answer carries', () => {
    expect(secretsIn({ project: { ...row } })).toEqual(['apiKey', 'webhookSecret', KEY, HOOK]);
  });
});
