import { beforeEach, describe, expect, it, vi } from 'vitest';

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
// lib/authz.ts effectiveProjectRole chains TWO leftJoins before where().limit(1).
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const selectSpy = vi.fn(() => ({ from: selectFrom }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: selectSpy,
  },
}));

const { forgeAgentSessionsListTool, forgeAgentSessionsGetTool } = await import(
  './forge-agent-sessions.js'
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
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

const baseSessionRow = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  userId: OWNER_ID,
  deviceId: DEVICE_ID,
  title: 'fake',
  status: 'idle' as const,
  messages: [],
  claudeSessionId: null,
  repoPath: null,
  usage: null,
  metadata: { issueId: ISSUE_ID },
  diff: null,
  pipelineControl: null,
  pipelineTelemetry: null,
  pipelineHealth: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_agent_sessions.list', () => {
  it('returns sessions filtered by issueId/status when device owner is member', async () => {
    const tool = forgeAgentSessionsListTool(fakeDevice);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]); // member check
    selectLimit.mockResolvedValueOnce([baseSessionRow]); // sessions query

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      status: 'idle',
    })) as { sessions: Array<{ id: string }> };

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.id).toBe(SESSION_ID);
  });

  it('rejects non-member with FORBIDDEN', async () => {
    const tool = forgeAgentSessionsListTool(fakeDevice);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]); // not a member
    await expect(tool.handler({ projectId: PROJECT_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  // ISS-428 — the list query must use a body-free column projection (never a
  // bare db.select()) so the multi-MB `messages` transcript can't overflow the
  // MCP token cap. Assert the projection map of the final (sessions) select.
  it('projects a body-free column set (no messages/diff jsonb; exposes messageCount)', async () => {
    const tool = forgeAgentSessionsListTool(fakeDevice);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]); // member check
    selectLimit.mockResolvedValueOnce([{ ...baseSessionRow, messageCount: 0 }]); // sessions query

    await tool.handler({ projectId: PROJECT_ID });

    // last db.select() call is the sessions list projection
    const lastCall = selectSpy.mock.calls.at(-1) as unknown[] | undefined;
    const projection = lastCall?.[0] as Record<string, unknown> | undefined;
    expect(projection).toBeDefined();
    const keys = Object.keys(projection ?? {});
    expect(keys).toContain('id');
    expect(keys).toContain('status');
    expect(keys).toContain('messageCount');
    for (const heavy of [
      'messages',
      'diff',
      'usage',
      'pipelineTelemetry',
      'pipelineHealth',
      'pipelineControl',
    ]) {
      expect(keys).not.toContain(heavy);
    }
  });
});

describe('forge_agent_sessions.get', () => {
  function makeDeviceCtx() {
    return {
      principal: { kind: 'device' as const, device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    };
  }

  it('truncates messages to last 20 and exposes totalMessages', async () => {
    const tool = forgeAgentSessionsGetTool(makeDeviceCtx());
    const messages = Array.from({ length: 35 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    selectLimit.mockResolvedValueOnce([{ ...baseSessionRow, messages }]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);

    const result = (await tool.handler({ sessionId: SESSION_ID })) as {
      session: { id: string; messages: Array<{ content: string }>; totalMessages: number };
    };
    expect(result.session.id).toBe(SESSION_ID);
    expect(result.session.totalMessages).toBe(35);
    expect(result.session.messages).toHaveLength(20);
    expect(result.session.messages[0]?.content).toBe('m15');
    expect(result.session.messages[19]?.content).toBe('m34');
  });

  it('handles non-array messages gracefully', async () => {
    const tool = forgeAgentSessionsGetTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([{ ...baseSessionRow, messages: null }]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);

    const result = (await tool.handler({ sessionId: SESSION_ID })) as {
      session: { messages: unknown[]; totalMessages: number };
    };
    expect(result.session.totalMessages).toBe(0);
    expect(result.session.messages).toEqual([]);
  });

  it('throws NOT_FOUND for missing session', async () => {
    const tool = forgeAgentSessionsGetTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([]);
    await expect(tool.handler({ sessionId: SESSION_ID })).rejects.toThrow(/NOT_FOUND/);
  });

  it('throws FORBIDDEN cross-project', async () => {
    const tool = forgeAgentSessionsGetTool(makeDeviceCtx());
    selectLimit.mockResolvedValueOnce([baseSessionRow]);
    selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: null, orgRole: null }]);
    await expect(tool.handler({ sessionId: SESSION_ID })).rejects.toThrow(/FORBIDDEN/);
  });

  // ISS-150 review #1 re-review — PAT projectIds allowlist regression on
  // sessionId-resolved access. Pre-fix this tool used the stub-device and
  // the allowlist was bypassed for users who were members of both projects.
  describe('PAT projectIds allowlist (cross-tenant)', () => {
    const ALLOWED_PROJECT = '77777777-7777-4777-8777-777777777777';

    function makePatTool(projectIds: string[] | null) {
      return forgeAgentSessionsGetTool({
        principal: {
          kind: 'pat',
          userId: OWNER_ID,
          tokenId: '88888888-8888-4888-8888-888888888888',
          scopes: ['read', 'write'],
          projectIds,
          boundProjectId: null,
        },
        device: fakeDevice,
        projectSlug: null,
      });
    }

    it('returns NOT_FOUND when the session’s project is outside the PAT allowlist (even if user is a member)', async () => {
      const tool = makePatTool([ALLOWED_PROJECT]);
      selectLimit.mockResolvedValueOnce([baseSessionRow]);
      await expect(tool.handler({ sessionId: SESSION_ID })).rejects.toThrow(/NOT_FOUND/);
    });

    it('succeeds when PAT allowlist includes the session’s project and user is a project owner', async () => {
      const tool = makePatTool([PROJECT_ID]);
      selectLimit.mockResolvedValueOnce([baseSessionRow]);
      selectLimit.mockResolvedValueOnce([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);
      const result = (await tool.handler({ sessionId: SESSION_ID })) as {
        session: { id: string };
      };
      expect(result.session.id).toBe(SESSION_ID);
    });
  });
});
