import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

// lib/authz.ts effectiveProjectRole chains TWO leftJoins before where().limit(1).
// Declare without default impl so mockResolvedValueOnce accepts any value.
const selectLimit = vi.fn();
const selectOrderBy = vi.fn();
const selectWhere = vi.fn();
const selectLeftJoin2 = vi.fn();
const selectLeftJoin = vi.fn();
const selectFrom = vi.fn();
const selectSpy = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: { select: selectSpy },
}));

// Mock the service so tests cover only the MCP gate + projection layer.
const listSchedulesMock = vi.fn();
const getScheduleMock = vi.fn();
const listScheduleRunsMock = vi.fn();
const createScheduleMock = vi.fn();
const updateScheduleMock = vi.fn();
const deleteScheduleMock = vi.fn();
const runScheduleNowMock = vi.fn();

vi.mock('../../schedules/service.js', () => ({
  listSchedules: (...a: unknown[]) => listSchedulesMock(...a),
  getSchedule: (...a: unknown[]) => getScheduleMock(...a),
  listScheduleRuns: (...a: unknown[]) => listScheduleRunsMock(...a),
  createSchedule: (...a: unknown[]) => createScheduleMock(...a),
  updateSchedule: (...a: unknown[]) => updateScheduleMock(...a),
  deleteSchedule: (...a: unknown[]) => deleteScheduleMock(...a),
  runScheduleNow: (...a: unknown[]) => runScheduleNowMock(...a),
}));

const fakeMessages = [
  { key: 'test-key', title: 'Test message', message: 'prompt', version: 1 },
];
vi.mock('../../schedules/messages/registry.js', () => ({
  listImprovementMessages: () => fakeMessages,
}));

const { forgeSchedulesTool } = await import('./forge-schedules.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const TOKEN_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = '66666666-6666-4666-8666-666666666666';

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

// Minimal schedule row as returned by list projection (no prompt).
const fakeScheduleRow = {
  id: SCHEDULE_ID,
  projectId: PROJECT_ID,
  name: 'Daily improvement',
  cron: '0 23 * * *',
  runner: 'desktop' as const,
  enabled: true,
  targetProjectSlug: null,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: null,
  templateKey: null,
  mode: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildDeviceCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

function buildPatCtx(scopes: string[], projectIds: string[] | null = null) {
  return {
    principal: {
      kind: 'pat' as const,
      userId: OWNER_ID,
      tokenId: TOKEN_ID,
      scopes,
      projectIds,
      boundProjectId: null,
    },
    device: fakeDevice,
    projectSlug: null,
  };
}

// Mock effectiveProjectRole returning a specific role.
function mockMemberRole(role: 'viewer' | 'member' | 'admin' | null) {
  selectLimit.mockResolvedValueOnce(
    role
      ? [{ orgId: 'org-1', memberRole: role, orgRole: null }]
      : [{ orgId: 'org-1', memberRole: null, orgRole: null }],
  );
}

// Mock the mini-fetch in fetchScheduleProjectId.
function mockScheduleProjectId(projectId = PROJECT_ID) {
  selectLimit.mockResolvedValueOnce([{ projectId }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish default chain implementations after clearAllMocks().
  selectLimit.mockImplementation(vi.fn());
  selectOrderBy.mockImplementation(() => ({ limit: selectLimit }));
  selectWhere.mockImplementation(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
  selectLeftJoin2.mockImplementation(() => ({ where: selectWhere }));
  selectLeftJoin.mockImplementation(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
  selectFrom.mockImplementation(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
  selectSpy.mockImplementation(() => ({ from: selectFrom }));
});

// ── list ──────────────────────────────────────────────────────────────────────

describe('forge_schedules action=list', () => {
  it('returns body-free projection for a member caller', async () => {
    mockMemberRole('member');
    selectOrderBy.mockResolvedValueOnce([fakeScheduleRow]);

    const tool = forgeSchedulesTool(buildDeviceCtx());
    const result = (await tool.handler({ action: 'list', projectId: PROJECT_ID })) as {
      schedules: Array<Record<string, unknown>>;
    };

    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]?.id).toBe(SCHEDULE_ID);
  });

  it('projection does not include prompt field (body-free)', async () => {
    mockMemberRole('member');
    selectOrderBy.mockResolvedValueOnce([fakeScheduleRow]);

    const tool = forgeSchedulesTool(buildDeviceCtx());
    await tool.handler({ action: 'list', projectId: PROJECT_ID });

    // The last db.select() call is the list projection — assert no prompt key.
    const lastCall = selectSpy.mock.calls.at(-1) as unknown[] | undefined;
    const projectionArg = lastCall?.[0] as Record<string, unknown> | undefined;
    expect(projectionArg).toBeDefined();
    const keys = Object.keys(projectionArg ?? {});
    expect(keys).not.toContain('prompt');
    expect(keys).toContain('id');
    expect(keys).toContain('name');
    expect(keys).toContain('cron');
    expect(keys).toContain('enabled');
    expect(keys).toContain('templateKey');
  });

  it('non-member device principal gets NOT_FOUND', async () => {
    mockMemberRole(null);

    const tool = forgeSchedulesTool(buildDeviceCtx());
    await expect(tool.handler({ action: 'list', projectId: PROJECT_ID })).rejects.toThrow(
      /FORBIDDEN/,
    );
  });

  it('PAT with project not in allowlist gets NOT_FOUND', async () => {
    // PAT has allowlist fenced to OTHER_PROJECT_ID, not PROJECT_ID.
    const tool = forgeSchedulesTool(buildPatCtx(['read'], [OTHER_PROJECT_ID]));
    await expect(tool.handler({ action: 'list', projectId: PROJECT_ID })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  it('PAT in allowlist with member role gets the list', async () => {
    mockMemberRole('member');
    selectOrderBy.mockResolvedValueOnce([fakeScheduleRow]);

    const tool = forgeSchedulesTool(buildPatCtx(['read'], [PROJECT_ID]));
    const result = (await tool.handler({ action: 'list', projectId: PROJECT_ID })) as {
      schedules: unknown[];
    };
    expect(result.schedules).toHaveLength(1);
  });

  it('rejects missing projectId with BAD_REQUEST', async () => {
    const tool = forgeSchedulesTool(buildDeviceCtx());
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/BAD_REQUEST/);
  });
});

// ── get ───────────────────────────────────────────────────────────────────────

describe('forge_schedules action=get', () => {
  it('returns full schedule row for a member', async () => {
    mockScheduleProjectId();
    mockMemberRole('member');
    getScheduleMock.mockResolvedValueOnce({ ...fakeScheduleRow, prompt: 'the prompt' });

    const tool = forgeSchedulesTool(buildDeviceCtx());
    const result = (await tool.handler({ action: 'get', scheduleId: SCHEDULE_ID })) as {
      schedule: Record<string, unknown>;
    };

    expect(result.schedule.id).toBe(SCHEDULE_ID);
    expect(result.schedule.prompt).toBe('the prompt');
  });

  it('throws NOT_FOUND when schedule does not exist', async () => {
    selectLimit.mockResolvedValueOnce([]); // fetchScheduleProjectId returns empty

    const tool = forgeSchedulesTool(buildDeviceCtx());
    await expect(tool.handler({ action: 'get', scheduleId: SCHEDULE_ID })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  it('non-member gets FORBIDDEN via assertPrincipalIsMember', async () => {
    mockScheduleProjectId();
    mockMemberRole(null);

    const tool = forgeSchedulesTool(buildDeviceCtx());
    await expect(tool.handler({ action: 'get', scheduleId: SCHEDULE_ID })).rejects.toThrow(
      /FORBIDDEN/,
    );
  });
});

// ── create ────────────────────────────────────────────────────────────────────

describe('forge_schedules action=create', () => {
  it('creates a schedule for an admin caller', async () => {
    mockMemberRole('admin');
    createScheduleMock.mockResolvedValueOnce({ ...fakeScheduleRow, prompt: 'do the thing' });

    const tool = forgeSchedulesTool(buildDeviceCtx());
    const result = (await tool.handler({
      action: 'create',
      projectId: PROJECT_ID,
      name: 'Daily improvement',
      cron: '0 23 * * *',
      prompt: 'do the thing',
    })) as { schedule: Record<string, unknown> };

    expect(result.schedule.id).toBe(SCHEDULE_ID);
    expect(createScheduleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        name: 'Daily improvement',
        cron: '0 23 * * *',
        prompt: 'do the thing',
      }),
      OWNER_ID,
    );
  });

  it('non-admin member gets FORBIDDEN', async () => {
    mockMemberRole('member'); // member but not admin

    const tool = forgeSchedulesTool(buildDeviceCtx());
    await expect(
      tool.handler({
        action: 'create',
        projectId: PROJECT_ID,
        name: 'x',
        cron: '0 * * * *',
        prompt: 'p',
      }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('PAT with admin scope + admin role can create', async () => {
    mockMemberRole('admin');
    createScheduleMock.mockResolvedValueOnce({ ...fakeScheduleRow, prompt: 'p' });

    const tool = forgeSchedulesTool(buildPatCtx(['read', 'admin'], [PROJECT_ID]));
    const result = (await tool.handler({
      action: 'create',
      projectId: PROJECT_ID,
      name: 'S',
      cron: '0 * * * *',
      prompt: 'p',
    })) as { schedule: Record<string, unknown> };

    expect(result.schedule).toBeDefined();
  });
});

// ── update ────────────────────────────────────────────────────────────────────

describe('forge_schedules action=update', () => {
  it('updates a schedule for an admin caller', async () => {
    mockScheduleProjectId();
    mockMemberRole('admin');
    updateScheduleMock.mockResolvedValueOnce({ ...fakeScheduleRow, enabled: false });

    const tool = forgeSchedulesTool(buildDeviceCtx());
    const result = (await tool.handler({
      action: 'update',
      scheduleId: SCHEDULE_ID,
      enabled: false,
    })) as { schedule: Record<string, unknown> };

    expect(result.schedule.enabled).toBe(false);
    expect(updateScheduleMock).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ enabled: false }),
      OWNER_ID,
    );
  });

  it('non-admin member gets FORBIDDEN for update', async () => {
    mockScheduleProjectId();
    mockMemberRole('member');

    const tool = forgeSchedulesTool(buildDeviceCtx());
    await expect(
      tool.handler({ action: 'update', scheduleId: SCHEDULE_ID, enabled: false }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe('forge_schedules action=delete', () => {
  it('deletes a schedule for an admin caller', async () => {
    mockScheduleProjectId();
    mockMemberRole('admin');
    deleteScheduleMock.mockResolvedValueOnce(undefined);

    const tool = forgeSchedulesTool(buildDeviceCtx());
    const result = (await tool.handler({ action: 'delete', scheduleId: SCHEDULE_ID })) as {
      deleted: boolean;
    };

    expect(result.deleted).toBe(true);
    expect(deleteScheduleMock).toHaveBeenCalledWith(SCHEDULE_ID, OWNER_ID);
  });
});

// ── run ───────────────────────────────────────────────────────────────────────

describe('forge_schedules action=run', () => {
  it('triggers a schedule for a writer (member)', async () => {
    mockScheduleProjectId();
    mockMemberRole('member'); // writer = member
    runScheduleNowMock.mockResolvedValueOnce({
      sessionId: SESSION_ID,
      message: 'Schedule triggered',
    });

    const tool = forgeSchedulesTool(buildDeviceCtx());
    const result = (await tool.handler({ action: 'run', scheduleId: SCHEDULE_ID })) as {
      sessionId: string;
    };

    expect(result.sessionId).toBe(SESSION_ID);
    expect(runScheduleNowMock).toHaveBeenCalledWith(SCHEDULE_ID, OWNER_ID);
  });

  it('viewer-only caller gets FORBIDDEN for run', async () => {
    mockScheduleProjectId();
    mockMemberRole('viewer'); // viewer is NOT a writer

    const tool = forgeSchedulesTool(buildDeviceCtx());
    await expect(tool.handler({ action: 'run', scheduleId: SCHEDULE_ID })).rejects.toThrow(
      /FORBIDDEN/,
    );
  });
});

// ── catalog ───────────────────────────────────────────────────────────────────

describe('forge_schedules action=catalog', () => {
  it('returns improvement message catalog for a member', async () => {
    mockMemberRole('member');

    const tool = forgeSchedulesTool(buildDeviceCtx());
    const result = (await tool.handler({ action: 'catalog', projectId: PROJECT_ID })) as {
      messages: Array<{ key: string }>;
    };

    expect(result.messages).toEqual(fakeMessages);
  });

  it('non-member gets FORBIDDEN for catalog', async () => {
    mockMemberRole(null);

    const tool = forgeSchedulesTool(buildDeviceCtx());
    await expect(
      tool.handler({ action: 'catalog', projectId: PROJECT_ID }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});
