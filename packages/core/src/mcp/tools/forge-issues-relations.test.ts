/**
 * ISS-868 — `forge_issues` and the dependency graph. `data.relations` was
 * parsed by the shared `data` schema and then dropped by update's field
 * whitelist: HTTP 200, the full issue back, nothing written, and no way for
 * the caller to tell. `get` reached no edge at all, so a token that could
 * write one still could not verify it landed.
 *
 * Separate from `forge-issues.test.ts` because that file's size budget is
 * frozen (`.forge/size-baseline.json`) and may only shrink.
 */

import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
const txUpdateWhere = vi.fn(() => {
  const thenable: PromiseLike<unknown> & { returning: typeof updateReturning } = {
    returning: updateReturning,
    then: (resolve, reject) => Promise.resolve(undefined).then(resolve as never, reject as never),
  };
  return thenable;
});
const txUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: txUpdateWhere })) }));
const txSelect = vi.fn(() => ({
  from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
}));
const txProxy = {
  update: txUpdate,
  insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  execute: vi.fn(async () => undefined),
  select: txSelect,
};

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    transaction: (cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy),
  },
}));

vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../jobs/dispatch-tick.js', () => ({ dispatchTickForProject: vi.fn() }));
vi.mock('../../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: vi.fn(async () => null),
}));
vi.mock('../../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('../../issues/attachment-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../issues/attachment-service.js')>();
  return { ...actual, listIssueAttachments: vi.fn(async () => []) };
});
vi.mock('../../issues/label-service.js', () => ({ listIssueLabels: vi.fn(async () => []) }));

const loadIssueRelationsMock = vi.fn(async (_id?: string, _projectId?: string) => ({
  blocks: [],
  blockedBy: [],
}));
vi.mock('../../issues/dependency-read.js', () => ({
  loadIssueRelations: (id: string, projectId: string) => loadIssueRelationsMock(id, projectId),
}));

// cm:guard `applyIssueRelations` (issues/relations-service.ts) reaches `setIssueDependency` across a module boundary, which is the only reason overriding the EXPORT works — inline that call into relations-service.ts and it bypasses this mock, so every relation test starts hitting the real DB chain and passes for the wrong reason
const setEdgeMock = vi.fn(async () => ({ id: 'dep-id-1', created: true }));
vi.mock('../../issues/dependency-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../issues/dependency-service.js')>();
  return {
    ...actual,
    setIssueDependency: setEdgeMock as unknown as typeof actual.setIssueDependency,
  };
});

const { forgeIssuesTool } = await import('./forge-issues.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_SLUG = 'forge-dev';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const BLOCKER_ID = '77777777-7777-4777-8777-777777777777';
const BLOCKED_ID = '88888888-8888-4888-8888-888888888888';
const ORG_ID = '99999999-9999-4999-8999-999999999999';
const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };

const fakeDevice = {
  id: '44444444-4444-4444-8444-444444444444',
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

const baseIssueRow = {
  id: ISSUE_ID,
  projectId: PROJECT_ID,
  issSeq: 1,
  title: 'Test issue',
  description: null,
  status: 'open' as const,
  priority: 'medium' as const,
  category: null,
  assigneeId: null,
  createdById: OWNER_ID,
  reopenCount: 0,
  source: 'manual' as const,
  externalId: null,
  plan: null,
  acceptanceCriteria: null,
  sessionContext: null,
  releaseNotes: null,
  mergedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const tool = () =>
  forgeIssuesTool({
    principal: { kind: 'device' as const, device: fakeDevice },
    device: fakeDevice,
    projectSlug: PROJECT_SLUG,
  });

const stageUpdate = (issueRow: Record<string, unknown> = baseIssueRow) => {
  selectLimit.mockResolvedValueOnce([issueRow]);
  selectLimit.mockResolvedValueOnce([memberAccessRow]);
  selectLimit.mockResolvedValueOnce([baseIssueRow]);
};

beforeEach(() => {
  vi.clearAllMocks();
  setEdgeMock.mockResolvedValue({ id: 'dep-id-1', created: true });
});

it('update writes the edge with dependsOnId on the from side and reports it back', async () => {
  stageUpdate();

  const result = (await tool().handler({
    action: 'update',
    documentId: ISSUE_ID,
    data: { relations: [{ dependsOnId: BLOCKER_ID, kind: 'blocks' }] },
  })) as { relations?: Array<Record<string, unknown>> };

  expect(setEdgeMock).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: PROJECT_ID,
      fromIssueId: BLOCKER_ID,
      toIssueId: ISSUE_ID,
      kind: 'blocks',
    }),
    { actor: { type: 'device', id: fakeDevice.id }, createdById: OWNER_ID },
    { deferHealthPublish: true },
  );
  expect(result.relations).toEqual([
    {
      edgeId: 'dep-id-1',
      kind: 'blocks',
      fromIssueId: BLOCKER_ID,
      toIssueId: ISSUE_ID,
      created: true,
      updated: false,
    },
  ]);
});

it('update writes the edge with blocksId on the to side', async () => {
  stageUpdate();

  await tool().handler({
    action: 'update',
    documentId: ISSUE_ID,
    data: { relations: [{ blocksId: BLOCKED_ID, kind: 'blocks' }] },
  });

  expect(setEdgeMock).toHaveBeenCalledWith(
    expect.objectContaining({ fromIssueId: ISSUE_ID, toIssueId: BLOCKED_ID }),
    { actor: { type: 'device', id: fakeDevice.id }, createdById: OWNER_ID },
    { deferHealthPublish: true },
  );
});

it('update passes validUntil through so an existing edge can be retracted', async () => {
  stageUpdate();
  setEdgeMock.mockResolvedValueOnce({
    id: 'dep-id-1',
    created: false,
    updated: true,
  } as never);

  const result = (await tool().handler({
    action: 'update',
    documentId: ISSUE_ID,
    data: {
      relations: [
        { dependsOnId: BLOCKER_ID, kind: 'blocks', validUntil: '2020-01-01T00:00:00.000Z' },
      ],
    },
  })) as { relations?: Array<Record<string, unknown>> };

  expect(setEdgeMock).toHaveBeenCalledWith(
    expect.objectContaining({ validUntil: '2020-01-01T00:00:00.000Z' }),
    { actor: { type: 'device', id: fakeDevice.id }, createdById: OWNER_ID },
    { deferHealthPublish: true },
  );
  expect(result.relations?.[0]).toMatchObject({ created: false, updated: true });
});

it('update commits the edge BEFORE the status transition that wakes the dispatcher', async () => {
  stageUpdate({ ...baseIssueRow, status: 'draft' });
  updateReturning.mockResolvedValue([baseIssueRow]);

  await tool().handler({
    action: 'update',
    documentId: ISSUE_ID,
    data: { status: 'open', relations: [{ dependsOnId: BLOCKER_ID, kind: 'blocks' }] },
  });

  const edgeAt = setEdgeMock.mock.invocationCallOrder[0];
  const transitionAt = updateReturning.mock.invocationCallOrder[0];
  expect(edgeAt).toBeDefined();
  expect(transitionAt).toBeDefined();
  expect(edgeAt as number).toBeLessThan(transitionAt as number);
});

it('update leaves the response status as the issue own status, not the literal "updated"', async () => {
  stageUpdate();

  const result = (await tool().handler({
    action: 'update',
    documentId: ISSUE_ID,
    data: { plan: 'new plan' },
  })) as { status: string; action: string };

  expect(result.status).toBe('open');
  expect(result.action).toBe('updated');
});

it('update without relations does not touch the dependency graph', async () => {
  stageUpdate();

  const result = (await tool().handler({
    action: 'update',
    documentId: ISSUE_ID,
    data: { plan: 'new plan' },
  })) as { relations?: unknown };

  expect(setEdgeMock).not.toHaveBeenCalled();
  expect(result.relations).toBeUndefined();
});

it('get returns the edges on both sides of the issue', async () => {
  selectLimit.mockResolvedValueOnce([baseIssueRow]);
  selectLimit.mockResolvedValueOnce([memberAccessRow]);
  loadIssueRelationsMock.mockResolvedValueOnce({
    blocks: [],
    blockedBy: [{ edgeId: 'dep-id-1', kind: 'blocks', expired: false }],
  } as never);

  const result = (await tool().handler({ action: 'get', documentId: ISSUE_ID })) as {
    relations: { blocks: unknown[]; blockedBy: Array<Record<string, unknown>> };
  };

  expect(loadIssueRelationsMock).toHaveBeenCalledWith(ISSUE_ID, PROJECT_ID);
  expect(result.relations.blocks).toEqual([]);
  expect(result.relations.blockedBy[0]).toMatchObject({ edgeId: 'dep-id-1', expired: false });
});

it('attributes the edge to the PAT user, not to the synthetic device standing in for it', async () => {
  const PAT_USER = '55555555-5555-4555-8555-555555555555';
  stageUpdate();
  selectLimit.mockResolvedValueOnce([memberAccessRow]);
  const patTool = forgeIssuesTool({
    principal: {
      kind: 'pat',
      agency: 'human',
      userId: PAT_USER,
      tokenId: '66666666-6666-4666-8666-666666666666',
      scopes: ['read', 'write'],
      projectIds: null,
      boundProjectId: null,
    },
    // cm:guard this device is the SYNTHETIC one mcp/handler.ts builds for a PAT — its id is an api_tokens row, not a devices row, which is exactly why the edge must not be attributed to it; give it a real device id and the test stops proving anything
    device: { ...fakeDevice, id: '66666666-6666-4666-8666-666666666666', ownerId: PAT_USER },
    projectSlug: PROJECT_SLUG,
  });

  await patTool.handler({
    action: 'update',
    documentId: ISSUE_ID,
    data: { relations: [{ dependsOnId: BLOCKER_ID, kind: 'blocks' }] },
  });

  expect(setEdgeMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ actor: { type: 'user', id: PAT_USER } }),
    { deferHealthPublish: true },
  );
});
