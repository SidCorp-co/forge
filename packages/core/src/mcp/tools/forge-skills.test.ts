import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

// db.select chain — only used by assertDeviceOwnerIsMember (effectiveProjectRole).
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

const listProjectSkillsMock = vi.fn();
vi.mock('../../skills/service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../skills/service.js')>();
  return {
    ...actual,
    listProjectSkills: (...args: unknown[]) => listProjectSkillsMock(...args),
  };
});

const { forgeSkillsListTool } = await import('./forge-skills.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  machineId: null,
  gitCredentialRef: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  disabledAt: null,
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

const projectSkillRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'forge-triage',
  description: 'Triage skill',
  scope: 'project' as const,
  projectId: PROJECT_ID,
  prompt: 'p'.repeat(5000),
  tools: ['a', 'b'],
  manifest: { big: 'm'.repeat(5000) },
  version: 3,
  contentHash: 'deadbeef',
  skillMd: '# body'.repeat(5000),
  target: 'coder' as const,
  files: [{ path: 'x', content: 'f'.repeat(5000) }],
  changelog: { entries: 'c'.repeat(5000) },
  localGuide: 'guide'.repeat(2000),
  evalScore: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_skills.list (ISS-428 body-free projection)', () => {
  it('omits heavy bodies and keeps catalog metadata + dedup hints', async () => {
    const tool = forgeSkillsListTool(fakeDevice);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]); // member check
    listProjectSkillsMock.mockResolvedValueOnce([projectSkillRow]);

    const result = (await tool.handler({ projectId: PROJECT_ID })) as {
      skills: Array<Record<string, unknown>>;
    };
    const row = result.skills[0] as Record<string, unknown>;
    // light catalog fields present
    expect(row.id).toBe(projectSkillRow.id);
    expect(row.name).toBe('forge-triage');
    expect(row.scope).toBe('project');
    expect(row.version).toBe(3);
    expect(row.shadowsGlobal).toBe(false);
    expect(row).toHaveProperty('shadowedGlobalSkillId');
    // heavy bodies omitted
    for (const heavy of [
      'skillMd',
      'prompt',
      'files',
      'tools',
      'manifest',
      'changelog',
      'localGuide',
    ]) {
      expect(row).not.toHaveProperty(heavy);
    }
  });

  it('rejects non-member with FORBIDDEN', async () => {
    const tool = forgeSkillsListTool(fakeDevice);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]); // not a member
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });
});
