import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const selectImpl = vi.fn();
const insertImpl = vi.fn();
const updateImpl = vi.fn();
const deleteImpl = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => selectImpl(...a),
    insert: (...a: unknown[]) => insertImpl(...a),
    update: (...a: unknown[]) => updateImpl(...a),
    delete: (...a: unknown[]) => deleteImpl(...a),
  },
}));

const { forgeProjectRunnersTool } = await import('./forge-project-runners.js');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_PROJECT_ID = '77777777-7777-4777-8777-777777777777';
const RUNNER_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN_ID = '66666666-6666-4666-8666-666666666666';

const fakeDevice = {
  id: DEVICE_ID,
  ownerId: OWNER_ID,
  name: 'fake',
  platform: 'linux' as const,
  agentVersion: null,
  tokenHash: '$argon2id$v=19$m=1,t=1,p=1$ZQ$ZQ',
  tokenPrefix: 'fake0001',
  status: 'online' as const,
  lastSeenAt: null,
  pairedAt: new Date(),
  capabilities: null,
  createdAt: new Date(),
};

function buildCtx() {
  return {
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: null,
  };
}

function buildPatCtx(opts: {
  scopes?: readonly string[];
  projectIds?: readonly string[] | null;
  userId?: string;
}) {
  return {
    principal: {
      kind: 'pat' as const,
      userId: opts.userId ?? OWNER_ID,
      tokenId: TOKEN_ID,
      scopes: opts.scopes ?? ['read', 'write'],
      projectIds: opts.projectIds ?? null,
    },
    device: fakeDevice,
    projectSlug: null,
  };
}

// db.select({...}).from(projects).where(...).limit(1)
function mockProjectOwnerLookup(ownerId: string | null) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(ownerId === null ? [] : [{ ownerId }]),
      }),
    }),
  }));
}

// db.select({...}).from(projectMembers).where(...).limit(1)
function mockMemberRoleLookup(role: string | null) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(role === null ? [] : [{ role }]),
      }),
    }),
  }));
}

// db.select({...}).from(runners).innerJoin(devices, ...).where(...)
function mockDevicePoolJoin(rows: unknown[]) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  }));
}

// db.select({ defaultDeviceId }).from(projects).where(...).limit(1)
function mockDefaultDeviceIdLookup(defaultDeviceId: string | null) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([{ defaultDeviceId }]),
      }),
    }),
  }));
}

// db.select({...}).from(devices).where(...).limit(1)
function mockDeviceLookup(
  row:
    | { id: string; name: string; status: string; lastSeenAt: Date | null }
    | null,
) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(row === null ? [] : [row]),
      }),
    }),
  }));
}

// db.select({ id }).from(runners).where(...).limit(1)
function mockBindingLookup(exists: boolean) {
  selectImpl.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(exists ? [{ id: RUNNER_ID }] : []),
      }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  selectImpl.mockReset();
  insertImpl.mockReset();
  updateImpl.mockReset();
  deleteImpl.mockReset();
});

describe('forge_project_runners — list', () => {
  it('returns devicePool + defaultDeviceId for project member (device principal)', async () => {
    // assertPrincipalIsMember → loadDeviceProjectRole: project ownerId lookup
    // (passes because OWNER_ID is the principal's device.ownerId).
    mockProjectOwnerLookup(OWNER_ID);
    mockDevicePoolJoin([
      {
        id: DEVICE_ID,
        name: 'dev-1',
        platform: 'linux',
        status: 'online',
        lastSeenAt: null,
        runnerId: RUNNER_ID,
      },
    ]);
    mockDefaultDeviceIdLookup(DEVICE_ID);

    const tool = forgeProjectRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'list',
      projectId: PROJECT_ID,
    })) as {
      devicePool: Array<{ id: string; runnerId: string }>;
      defaultDeviceId: string | null;
    };
    expect(res.devicePool).toHaveLength(1);
    expect(res.devicePool[0]?.runnerId).toBe(RUNNER_ID);
    expect(res.defaultDeviceId).toBe(DEVICE_ID);
  });

  it('FORBIDDEN when device owner is not a project member', async () => {
    // Project exists but owned by someone else, no projectMembers row.
    mockProjectOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup(null);
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({ action: 'list', projectId: PROJECT_ID }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it('PAT principal with read scope passes', async () => {
    mockProjectOwnerLookup(OWNER_ID);
    mockDevicePoolJoin([]);
    mockDefaultDeviceIdLookup(null);
    const tool = forgeProjectRunnersTool(buildPatCtx({ scopes: ['read'] }));
    const res = (await tool.handler({
      action: 'list',
      projectId: PROJECT_ID,
    })) as { devicePool: unknown[]; defaultDeviceId: string | null };
    expect(res.devicePool).toEqual([]);
    expect(res.defaultDeviceId).toBeNull();
  });

  it('PAT without read scope is FORBIDDEN_SCOPE before any DB lookup', async () => {
    const tool = forgeProjectRunnersTool(buildPatCtx({ scopes: ['write'] }));
    await expect(
      tool.handler({ action: 'list', projectId: PROJECT_ID }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE: requires read scope/);
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('PAT with allowlist miss is NOT_FOUND without touching DB', async () => {
    const tool = forgeProjectRunnersTool(
      buildPatCtx({ scopes: ['read'], projectIds: [OTHER_PROJECT_ID] }),
    );
    await expect(
      tool.handler({ action: 'list', projectId: PROJECT_ID }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(selectImpl).not.toHaveBeenCalled();
  });
});

describe('forge_project_runners — add', () => {
  function mockUpsert(row: Record<string, unknown>) {
    insertImpl.mockImplementationOnce(() => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([row]),
        }),
      }),
    }));
  }

  it('owner upserts a runner and receives the row', async () => {
    mockProjectOwnerLookup(OWNER_ID); // assertPrincipalIsAdmin passes immediately
    mockDeviceLookup({
      id: DEVICE_ID,
      name: 'dev-1',
      status: 'online',
      lastSeenAt: new Date(),
    });
    mockUpsert({
      id: RUNNER_ID,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      status: 'online',
    });
    const tool = forgeProjectRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'add',
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
    })) as { runner: { id: string; status: string } };
    expect(res.runner.id).toBe(RUNNER_ID);
    expect(res.runner.status).toBe('online');
  });

  it('derives status=offline when device is online but has no lastSeenAt', async () => {
    mockProjectOwnerLookup(OWNER_ID);
    mockDeviceLookup({
      id: DEVICE_ID,
      name: 'dev-1',
      status: 'online',
      lastSeenAt: null,
    });
    mockUpsert({
      id: RUNNER_ID,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      status: 'offline',
    });
    const tool = forgeProjectRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'add',
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
    })) as { runner: { status: string } };
    expect(res.runner.status).toBe('offline');
  });

  it('member-only (not admin) is FORBIDDEN', async () => {
    mockProjectOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup('member');
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({ action: 'add', projectId: PROJECT_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(insertImpl).not.toHaveBeenCalled();
  });

  it('admin-role member can add', async () => {
    mockProjectOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup('admin');
    mockDeviceLookup({
      id: DEVICE_ID,
      name: 'dev-1',
      status: 'online',
      lastSeenAt: new Date(),
    });
    mockUpsert({
      id: RUNNER_ID,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      status: 'online',
    });
    const tool = forgeProjectRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'add',
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
    })) as { runner: { id: string } };
    expect(res.runner.id).toBe(RUNNER_ID);
  });

  it('NOT_FOUND DEVICE_NOT_FOUND when device row is missing', async () => {
    mockProjectOwnerLookup(OWNER_ID);
    mockDeviceLookup(null);
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({ action: 'add', projectId: PROJECT_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow(/NOT_FOUND: DEVICE_NOT_FOUND/);
    expect(insertImpl).not.toHaveBeenCalled();
  });

  it('BAD_REQUEST when deviceId is omitted', async () => {
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({ action: 'add', projectId: PROJECT_ID }),
    ).rejects.toThrow(/BAD_REQUEST: deviceId is required/);
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('PAT without write scope is FORBIDDEN_SCOPE before any DB lookup', async () => {
    const tool = forgeProjectRunnersTool(buildPatCtx({ scopes: ['read'] }));
    await expect(
      tool.handler({ action: 'add', projectId: PROJECT_ID, deviceId: DEVICE_ID }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE: requires write scope/);
    expect(selectImpl).not.toHaveBeenCalled();
  });
});

describe('forge_project_runners — remove', () => {
  function mockDelete() {
    deleteImpl.mockImplementationOnce(() => ({
      where: () => Promise.resolve(undefined),
    }));
  }

  it('owner removes runner — ok:true', async () => {
    mockProjectOwnerLookup(OWNER_ID);
    mockDelete();
    const tool = forgeProjectRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'remove',
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it('idempotent — returns ok:true even when no row matched', async () => {
    mockProjectOwnerLookup(OWNER_ID);
    mockDelete(); // delete still resolves with no .returning() — handler doesn't read affected count
    const tool = forgeProjectRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'remove',
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it('member-only (not admin) is FORBIDDEN', async () => {
    mockProjectOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup('member');
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({
        action: 'remove',
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(deleteImpl).not.toHaveBeenCalled();
  });

  it('PAT without write scope is FORBIDDEN_SCOPE before any DB lookup', async () => {
    const tool = forgeProjectRunnersTool(buildPatCtx({ scopes: ['read'] }));
    await expect(
      tool.handler({
        action: 'remove',
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE: requires write scope/);
    expect(selectImpl).not.toHaveBeenCalled();
  });
});

describe('forge_project_runners — setDefault', () => {
  function mockProjectsUpdate(defaultDeviceId: string | null) {
    updateImpl.mockImplementationOnce(() => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([{ id: PROJECT_ID, defaultDeviceId }]),
        }),
      }),
    }));
  }

  it('primary owner sets default — short-circuits the member lookup', async () => {
    mockProjectOwnerLookup(OWNER_ID);
    mockBindingLookup(true);
    mockProjectsUpdate(DEVICE_ID);
    const tool = forgeProjectRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'setDefault',
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
    })) as { project: { id: string; defaultDeviceId: string } };
    expect(res.project.defaultDeviceId).toBe(DEVICE_ID);
    // No member lookup — exactly 2 selects (owner + binding).
    expect(selectImpl).toHaveBeenCalledTimes(2);
  });

  it('owner-role member is accepted', async () => {
    mockProjectOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup('owner');
    mockBindingLookup(true);
    mockProjectsUpdate(DEVICE_ID);
    const tool = forgeProjectRunnersTool(buildCtx());
    const res = (await tool.handler({
      action: 'setDefault',
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
    })) as { project: { defaultDeviceId: string } };
    expect(res.project.defaultDeviceId).toBe(DEVICE_ID);
  });

  it('admin-role member is REFUSED — owner-only gate (matches REST PATCH)', async () => {
    mockProjectOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup('admin');
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({
        action: 'setDefault',
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow(/FORBIDDEN: requires project owner/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('non-member is NOT_FOUND (no existence leak)', async () => {
    mockProjectOwnerLookup(OTHER_OWNER_ID);
    mockMemberRoleLookup(null);
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({
        action: 'setDefault',
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('non-existent project is NOT_FOUND', async () => {
    mockProjectOwnerLookup(null);
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({
        action: 'setDefault',
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow(/NOT_FOUND/);
  });

  it('BAD_REQUEST DEVICE_NOT_BOUND when device is not bound to the project', async () => {
    mockProjectOwnerLookup(OWNER_ID);
    mockBindingLookup(false);
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({
        action: 'setDefault',
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow(/BAD_REQUEST: DEVICE_NOT_BOUND/);
    expect(updateImpl).not.toHaveBeenCalled();
  });

  it('PAT without write scope is FORBIDDEN_SCOPE before any DB lookup', async () => {
    const tool = forgeProjectRunnersTool(buildPatCtx({ scopes: ['read'] }));
    await expect(
      tool.handler({
        action: 'setDefault',
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow(/FORBIDDEN_SCOPE: requires write scope/);
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('PAT with allowlist miss returns NOT_FOUND without touching DB', async () => {
    const tool = forgeProjectRunnersTool(
      buildPatCtx({ scopes: ['read', 'write'], projectIds: [OTHER_PROJECT_ID] }),
    );
    await expect(
      tool.handler({
        action: 'setDefault',
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
      }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(selectImpl).not.toHaveBeenCalled();
  });

  it('BAD_REQUEST when deviceId is omitted', async () => {
    const tool = forgeProjectRunnersTool(buildCtx());
    await expect(
      tool.handler({ action: 'setDefault', projectId: PROJECT_ID }),
    ).rejects.toThrow(/BAD_REQUEST: deviceId is required/);
    expect(selectImpl).not.toHaveBeenCalled();
  });
});
