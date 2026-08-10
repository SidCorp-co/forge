import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertOnConflictDoUpdate = vi.fn(() => ({ returning: insertReturning }));
const insertValues = vi.fn(() => ({
  onConflictDoUpdate: insertOnConflictDoUpdate,
  returning: insertReturning,
}));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const txExecute = vi.fn(async () => undefined);

const txProxy = {
  select: vi.fn(() => ({ from: selectFrom })),
  insert: vi.fn(() => ({ values: insertValues })),
  update: vi.fn(() => ({ set: updateSet })),
  execute: txExecute,
};

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    transaction: vi.fn(async (cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy)),
  },
}));

const registerSkillForProjectMock = vi.fn(async () => ({ projectId: '', skillId: '', stage: null }));
const resolveOrAdoptProjectSkillMock = vi.fn(
  async (_projectId: string, _skillName: string): Promise<string | null> => null,
);
vi.mock('../skills/service.js', () => ({
  registerSkillForProject: registerSkillForProjectMock,
  resolveOrAdoptProjectSkill: resolveOrAdoptProjectSkillMock,
}));

const { applyTemplate, TemplateNotFoundError } = await import('./apply.js');

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const APP_CONFIG_ID = '44444444-4444-4444-8444-444444444444';
const SKILL_ID = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  insertReturning.mockReset();
  updateReturning.mockReset();
  registerSkillForProjectMock.mockReset();
  registerSkillForProjectMock.mockResolvedValue({ projectId: '', skillId: '', stage: null });
  resolveOrAdoptProjectSkillMock.mockReset();
  resolveOrAdoptProjectSkillMock.mockResolvedValue(null);
});

const baseManifest = {
  agentConfig: {
    name: 'Test Agent',
    type: 'test-domain',
    enabled: true,
  },
  appConfigDefaults: { retrievalTopK: 7 },
};

describe('applyTemplate', () => {
  it('throws TemplateNotFoundError when key missing', async () => {
    selectLimit.mockResolvedValueOnce([]); // template lookup
    await expect(
      applyTemplate({ projectId: PROJECT_ID, templateKey: 'missing', actorUserId: USER_ID }),
    ).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('inserts a fresh agent + upserts app_config when no agent exists for type', async () => {
    selectLimit.mockResolvedValueOnce([{ key: 'test', manifest: baseManifest }]); // template
    selectLimit.mockResolvedValueOnce([]); // existing agent lookup
    insertReturning.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent insert
    insertReturning.mockResolvedValueOnce([{ id: APP_CONFIG_ID }]); // app_config upsert

    const result = await applyTemplate({
      projectId: PROJECT_ID,
      templateKey: 'test',
      actorUserId: USER_ID,
    });
    expect(result.agentId).toBe(AGENT_ID);
    expect(result.appConfigId).toBe(APP_CONFIG_ID);
    expect(result.registeredSkillNames).toEqual([]);
    expect(result.skippedSkillNames).toEqual([]);
  });

  it('updates an existing agent of same type instead of duplicating', async () => {
    selectLimit.mockResolvedValueOnce([{ key: 'test', manifest: baseManifest }]);
    selectLimit.mockResolvedValueOnce([{ id: AGENT_ID }]); // existing agent
    updateReturning.mockResolvedValueOnce([{ id: AGENT_ID }]);
    insertReturning.mockResolvedValueOnce([{ id: APP_CONFIG_ID }]);

    const result = await applyTemplate({
      projectId: PROJECT_ID,
      templateKey: 'test',
      actorUserId: USER_ID,
    });
    expect(result.agentId).toBe(AGENT_ID);
  });

  it('registers known skills and skips unknown ones', async () => {
    const manifest = {
      ...baseManifest,
      skillRegistrations: [
        { skillName: 'forge-triage', stage: 'open' as const },
        { skillName: 'unknown-skill', stage: 'confirmed' as const },
      ],
    };
    selectLimit.mockResolvedValueOnce([{ key: 'test', manifest }]); // template
    selectLimit.mockResolvedValueOnce([]); // existing agent
    insertReturning.mockResolvedValueOnce([{ id: AGENT_ID }]); // agent
    insertReturning.mockResolvedValueOnce([{ id: APP_CONFIG_ID }]); // app_config
    // forge-triage adopts to a project skill (SKILL_ID); unknown-skill resolves to nothing.
    resolveOrAdoptProjectSkillMock.mockImplementation(async (_projectId: string, name: string) =>
      name === 'forge-triage' ? SKILL_ID : null,
    );

    const result = await applyTemplate({
      projectId: PROJECT_ID,
      templateKey: 'test',
      actorUserId: USER_ID,
    });
    expect(result.registeredSkillNames).toEqual(['forge-triage']);
    expect(result.skippedSkillNames).toEqual(['unknown-skill']);
    expect(registerSkillForProjectMock).toHaveBeenCalledTimes(1);
    expect(registerSkillForProjectMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      skillId: SKILL_ID,
      stage: 'open',
      actorUserId: USER_ID,
    });
  });
});
