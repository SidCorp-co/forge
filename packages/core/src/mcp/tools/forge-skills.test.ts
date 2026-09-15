import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeContext, makeFakePrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
  },
}));

const listProjectSkillCatalogMock = vi.fn();
vi.mock('../../skills/service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../skills/service.js')>();
  return {
    ...actual,
    listProjectSkillCatalog: (...args: unknown[]) => listProjectSkillCatalogMock(...args),
  };
});

const { forgeSkillsListTool } = await import('./forge-skills.js');
const { skillListProjection } = await import('../../skills/service.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakePrincipal = makeFakePrincipal(DEVICE_ID, OWNER_ID);

/** What `skillListProjection` returns — the catalog columns and nothing else. */
const projectSkillRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'forge-triage',
  description: 'Triage skill',
  scope: 'project' as const,
  projectId: PROJECT_ID,
  version: 3,
  contentHash: 'deadbeef',
  target: 'coder' as const,
  evalScore: null,
  basedOnGlobalVersion: null,
  pinned: false,
  pinnedReason: null,
};

/** The seven fields ISS-428 removed from the response and ISS-1025 from the query. */
const HEAVY_FIELDS = [
  'skillMd',
  'prompt',
  'files',
  'tools',
  'manifest',
  'changelog',
  'localGuide',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_skills.list (ISS-428 body-free projection)', () => {
  it('omits heavy bodies and keeps catalog metadata + dedup hints', async () => {
    const tool = forgeSkillsListTool(makeFakeContext(fakePrincipal));
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    listProjectSkillCatalogMock.mockResolvedValueOnce([projectSkillRow]);

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      skills: Array<Record<string, unknown>>;
    };
    const row = result.skills[0] as Record<string, unknown>;
    expect(row.id).toBe(projectSkillRow.id);
    expect(row.name).toBe('forge-triage');
    expect(row.scope).toBe('project');
    expect(row.version).toBe(3);
    expect(row.shadowsGlobal).toBe(false);
    expect(row).toHaveProperty('shadowedGlobalSkillId');
    // heavy bodies omitted
    for (const heavy of HEAVY_FIELDS) {
      expect(row).not.toHaveProperty(heavy);
    }
  });

  /**
   * ISS-1025 — ISS-428 dropped the seven heavy fields from the RESPONSE while
   * the query kept selecting them for every global and project skill. The
   * response assertion above cannot see that; this reads the projection the
   * catalog query is built from.
   */
  it('the catalog projection asks the database for none of the heavy fields', () => {
    for (const heavy of HEAVY_FIELDS) {
      expect(skillListProjection).not.toHaveProperty(heavy);
    }
  });

  it('the catalog projection is exactly the stored columns the row renders', () => {
    expect(Object.keys(skillListProjection).sort()).toEqual(
      [
        'basedOnGlobalVersion',
        'contentHash',
        'description',
        'evalScore',
        'id',
        'name',
        'pinned',
        'pinnedReason',
        'projectId',
        'scope',
        'target',
        'version',
      ].sort(),
    );
  });

  /**
   * The response contract: ISS-1025 narrowed the QUERY and must have moved no
   * key. Fifteen — the twelve stored columns plus the three the dedup derives.
   */
  it('renders the same fifteen keys per skill', async () => {
    const tool = forgeSkillsListTool(makeFakeContext(fakePrincipal));
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
    listProjectSkillCatalogMock.mockResolvedValueOnce([projectSkillRow]);

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      skills: Array<Record<string, unknown>>;
    };
    expect(Object.keys(result.skills[0] ?? {}).sort()).toEqual(
      [
        'basedOnGlobalVersion',
        'contentHash',
        'description',
        'evalScore',
        'id',
        'name',
        'pinned',
        'pinnedReason',
        'projectId',
        'scope',
        'shadowedGlobalSkillId',
        'shadowsGlobal',
        'target',
        'templateVersion',
        'version',
      ].sort(),
    );
  });

  it('rejects a non-member as not-found (existence-hiding)', async () => {
    const tool = forgeSkillsListTool(makeFakeContext(fakePrincipal));
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]); // not a member
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/NOT_FOUND/);
  });
});
