import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeJobPrincipal } from '../fake-principal.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
  },
}));

const storagePut = vi.fn(async (key: string, _bytes: Buffer, _mime: string) => ({
  path: `local:${key}`,
  size: _bytes.byteLength,
}));
vi.mock('../../storage/index.js', () => ({
  getStorage: () => ({
    put: storagePut,
    get: vi.fn(),
    delete: vi.fn(),
  }),
  isEnoent: () => false,
}));

// cm:guard every chain step returns the NEXT mock, so a test programs its rows with `mockResolvedValueOnce` in the order the subject queries them — insert a query anywhere in a handler and every later expectation in that test reads someone else's row
const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
// lib/authz.ts effectiveProjectRole chains TWO leftJoins before where().limit(1).
const selectLeftJoin2 = vi.fn(() => ({ where: selectWhere }));
const selectLeftJoin = vi.fn(() => ({ leftJoin: selectLeftJoin2, where: selectWhere }));
const selectFrom = vi.fn(() => ({ where: selectWhere, leftJoin: selectLeftJoin }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn((_set?: unknown) => ({ where: updateWhere }));

// txUpdateWhere supports BOTH a direct await (manual-hold / activity write
// flows) AND `.returning(...)` (the ISS-196 status-UPDATE that flows through
// withActorContext into `tx.update(issues)...returning(...)`).
const txUpdateWhere = vi.fn(() => {
  const thenable: PromiseLike<unknown> & { returning: typeof updateReturning } = {
    returning: updateReturning,
    then: (resolve, reject) => Promise.resolve(undefined).then(resolve as never, reject as never),
  };
  return thenable;
});
const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
const txUpdate = vi.fn(() => ({ set: txUpdateSet }));
// cm:guard the tx insert must satisfy BOTH shapes — a bare await (the issueLabels rows) and `.returning()` (the issue row, staged per test via insertReturning) — because ISS-889 moved create's `insert(issues)` inside the transaction alongside the label rows; drop either and every create test fails on a shape, not on the behaviour it asserts
const txInsertValues = vi.fn((_values?: unknown) => ({
  returning: insertReturning,
  then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
}));
const txInsert = vi.fn(() => ({ values: txInsertValues }));
const txDeleteWhere = vi.fn(async () => undefined);
const txDelete = vi.fn(() => ({ where: txDeleteWhere }));
// ISS-196 — `withActorContext` calls `tx.execute(SELECT set_config(...))`
// before the UPDATE; stub it so the in-memory db mock doesn't blow up.
const txExecute = vi.fn(async () => undefined);
// ISS-232 — `markMergedIfLeavingBase` issues a 2nd `tx.select(...).from
// (projects)...` to resolve `mergeStates`. ISS-633's label replace-set also
// reads existing `issueLabels` via `tx.select(...).from(...).where(...).limit(...)`.
// Stub as an empty resolve so both helpers short-circuit with defaults under
// the in-memory db mock unless a test stages a specific value.
const txSelectLimit = vi.fn(async () => [] as unknown[]);
const txSelectWhere = vi.fn(() => ({ limit: txSelectLimit }));
const txSelectFrom = vi.fn(() => ({ where: txSelectWhere }));
const txSelect = vi.fn(() => ({ from: txSelectFrom }));
const txProxy = {
  update: txUpdate,
  insert: txInsert,
  delete: txDelete,
  execute: txExecute,
  select: txSelect,
};
const transactionMock = vi.fn(async (cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy));

const deleteWhere = vi.fn(async () => undefined);
const deleteFrom = vi.fn(() => ({ where: deleteWhere }));

// cm:why ISS-889 — `update` and the four task actions are adapters now, so this file asserts only what the TOOL owns (argument mapping, authorization, error vocabulary, response shape); the writes themselves are covered in issues/update-service.test.ts and tasks/task-service.test.ts, at the layer that still builds the drizzle chain
type UpdateIssueFieldsInput = {
  issueId: string;
  updates: Record<string, unknown>;
  labelIds?: Array<{ labelId: string; isPrimary: boolean }>;
  actor: { type: string; id: string };
};
const updateIssueFieldsMock = vi.fn(async (_input: UpdateIssueFieldsInput) => ({}) as never);
vi.mock('../../issues/update-service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  updateIssueFields: (input: UpdateIssueFieldsInput) => updateIssueFieldsMock(input),
}));

const createTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const deleteTaskMock = vi.fn(async () => undefined);
const findTaskByIdMock = vi.fn();
const listTasksForIssueMock = vi.fn(async () => [] as never[]);
vi.mock('../../tasks/task-service.js', () => ({
  createTask: (...a: unknown[]) => createTaskMock(...(a as [])),
  updateTask: (...a: unknown[]) => updateTaskMock(...(a as [])),
  deleteTask: (...a: unknown[]) => deleteTaskMock(...(a as [])),
  findTaskById: (...a: unknown[]) => findTaskByIdMock(...(a as [])),
  listTasksForIssue: (...a: unknown[]) => listTasksForIssueMock(...(a as [])),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => deleteFrom()),
    transaction: (cb: (tx: typeof txProxy) => Promise<unknown>) => transactionMock(cb),
  },
}));

// ISS-606: pass-through — the intake gate has its own unit tests
// (issues/intake-gate.test.ts); create tests here exercise create mechanics.
vi.mock('../../issues/intake-gate.js', () => ({
  applyIntakeGate: vi.fn(async (_projectId: string, status: string) => ({ status, gated: false })),
  finalizeIntake: vi.fn(async () => undefined),
}));

vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn().mockResolvedValue(undefined) },
}));

// ISS-786 child B — mocked independently of the generic `db.select` chain
// (real evidence collection is unit-tested in `pipeline/work-evidence.test.ts`).
// Defaults to "evidence found" (null violation) so the dozens of pre-existing
// mark_merged tests don't need to stage extra queries; the refusal path tests
// below override per-call.
const findMissingWorkEvidenceMock = vi.fn<() => Promise<string | null>>(async () => null);
vi.mock('../../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: (...args: unknown[]) => findMissingWorkEvidenceMock(...(args as [])),
}));

vi.mock('../../ws/server.js', () => ({
  roomManager: { publish: vi.fn() },
}));

// Keep the real create-path helpers (decode/persist) but stub the read-side
// attachment join so get/transition/update/etc. don't need a programmed query
// chain. The real join is its own concern (tested via the helper).
const listIssueAttachmentsMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock('../../issues/attachment-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../../issues/attachment-service.js')>();
  return {
    ...actual,
    listIssueAttachments: (...args: unknown[]) => listIssueAttachmentsMock(...args),
  };
});

// ISS-633 — mocked independently of the generic `db.select` chain (it uses an
// innerJoin the top-level mock doesn't model) so the dozens of pre-existing
// get/update/transition/mark_merged/unmark tests don't need to stage an extra
// query. Defaults to no labels; individual label tests override per-call.
const listIssueLabelsMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
// cm:guard override ONLY `listIssueLabels` here — `resolveLabelIdsForWrite` and `LabelResolutionError` must stay REAL, or the create/update label tests assert against a stub and the BAD_REQUEST mapping in forge-issues.ts compares against an undefined class
vi.mock('../../issues/label-service.js', async (importActual) => ({
  ...(await importActual<typeof import('../../issues/label-service.js')>()),
  listIssueLabels: (...args: unknown[]) => listIssueLabelsMock(...args),
}));

// cm:guard the relations read joins `issues` twice, which the generic db.select chain above does not model — leave this mocked to an EMPTY graph, because every pre-existing `get` test in this file reaches it and would otherwise die on `outgoingRows.map is not a function` (ISS-868)
vi.mock('../../issues/dependency-read.js', () => ({
  loadIssueRelations: vi.fn(async () => ({ blocks: [], blockedBy: [] })),
}));
// cm:why stubbing the shared edge write keeps create-with-relations tests off the full DB chain the real one walks; the ordering they assert is the tool's, not the edge write's
const setEdgeMock = vi.fn(async () => ({
  id: 'dep-id-1',
  created: true,
  updated: false,
  effect: 'added' as const,
}));
const emitEdgeMock = vi.fn(async () => undefined);
type DepService = typeof import('../../issues/dependency-service.js');
vi.mock('../../issues/dependency-service.js', async (importActual) => ({
  ...(await importActual<DepService>()),
  writeIssueDependency: setEdgeMock as unknown as DepService['writeIssueDependency'],
  emitIssueDependencyEffects: emitEdgeMock as unknown as DepService['emitIssueDependencyEffects'],
}));

const { forgeIssuesTool } = await import('./forge-issues.js');
const { findVerifiedClaimViolation } = await import('../../issues/session-context.js');
const { db: mockDb } = await import('../../db/client.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_SLUG = 'forge-dev';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

// effectiveProjectRole (lib/authz.ts) result rows — ONE org-aware select.
const ORG_ID = '99999999-9999-4999-8999-999999999999';
const memberAccessRow = { orgId: ORG_ID, memberRole: 'member', orgRole: null };

// cm:guard a MACHINE principal, because a paired device is what these cases used to run as and `agency: 'agent'` is the load-bearing half of that. It is what turns the ISS-786/812 evidence gates ON — a `makeFakePrincipal` here reads as a person, the gates skip, and `mark_merged refuses ... with no recorded code evidence` passes for the wrong reason (ISS-931).
const fakePrincipal = makeFakeJobPrincipal(
  DEVICE_ID,
  OWNER_ID,
  '00000000-0000-4000-8000-00000000abcd',
);

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

beforeEach(() => {
  vi.clearAllMocks();
});

const humanPat = (userId: string, tokenId: string, projectIds: string[] | null) =>
  ({
    kind: 'pat',
    agency: 'human',
    userId,
    tokenId,
    scopes: ['read', 'write'],
    projectIds,
    boundProjectId: null,
    machine: null,
  }) as const;

describe('forge_issues tool', () => {
  it('rejects unknown action', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    await expect(
      tool.handler({ action: 'wat' } as unknown as Record<string, unknown>),
    ).rejects.toThrow();
  });

  it('list resolves projectId from slug header and enforces membership', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // 1. resolveProjectIdFromSlug → projects.id
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember → projects.ownerId (matches device.ownerId)
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // 3. issue list query
    selectLimit.mockResolvedValueOnce([baseIssueRow]);

    const result = (await tool.handler({ action: 'list' })) as {
      issues: Array<{ documentId: string }>;
    };
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.documentId).toBe(ISSUE_ID);
  });

  // ISS-428 — list must return a body-free projection so it never overflows
  // the MCP token cap; heavy fields stay reachable via action=get.
  it('list omits heavy body fields and keeps the light summary fields', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([
      {
        ...baseIssueRow,
        description: 'x'.repeat(5000),
        plan: 'p'.repeat(5000),
        acceptanceCriteria: 'a'.repeat(5000),
        sessionContext: { big: 'c'.repeat(5000) },
        releaseNotes: { section: 'Fixed', userFacing: 'note' },
      },
    ]);

    const result = (await tool.handler({ action: 'list' })) as {
      issues: Array<Record<string, unknown>>;
    };
    const row = result.issues[0] as Record<string, unknown>;
    // light fields present
    expect(row.documentId).toBe(ISSUE_ID);
    expect(row.issueId).toBe('ISS-1');
    expect(row.title).toBe('Test issue');
    expect(row.status).toBe('open');
    // heavy fields omitted
    for (const heavy of [
      'description',
      'plan',
      'acceptanceCriteria',
      'sessionContext',
      'releaseNotes',
    ]) {
      expect(row).not.toHaveProperty(heavy);
    }
  });

  // ISS-562 — SQL-level projection: assert db.select() is called with a
  // light-column projection map, NOT bare (no args). A returned-row assertion
  // won't catch this because the unit-test mock bypasses drizzle column
  // selection.
  it('list calls db.select with SQL-level light-column projection — no heavy fields (ISS-562)', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    selectLimit.mockResolvedValueOnce([baseIssueRow]);

    await tool.handler({ action: 'list' });

    // db.select was called with a projection object (not undefined/no-args)
    const selectSpy = vi.mocked(mockDb.select);
    const callArg = selectSpy.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
    expect(callArg).toBeDefined();
    // Light fields present in projection
    for (const light of [
      'id',
      'issSeq',
      'title',
      'status',
      'priority',
      'category',
      'complexity',
      'assigneeId',
      'reopenCount',
      'mergedAt',
      'createdAt',
      'updatedAt',
    ]) {
      expect(callArg).toHaveProperty(light);
    }
    // Heavy fields absent from projection
    for (const heavy of [
      'description',
      'plan',
      'acceptanceCriteria',
      'sessionContext',
      'releaseNotes',
    ]) {
      expect(callArg).not.toHaveProperty(heavy);
    }
  });

  it('list returns truncated:true and stays under output cap when fat rows exceed 38K chars (ISS-562)', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // 50 fat issue rows (title ~2KB each) — total well exceeds 38K
    const fatRows = Array.from({ length: 50 }, (_, i) => ({
      ...baseIssueRow,
      id: `22222222-2222-4222-8222-22222222222${(i % 10).toString()}`,
      title: 't'.repeat(2_000),
    }));
    selectLimit.mockResolvedValueOnce(fatRows);

    const result = (await tool.handler({ action: 'list' })) as {
      issues: unknown[];
      truncated: boolean;
      returned: number;
      limit: number;
      truncatedBy: string;
      notice: string;
    };

    expect(result.truncated).toBe(true);
    expect(result.returned).toBeLessThan(50);
    expect(result.limit).toBe(25);
    expect(result.truncatedBy).toBe('limit+response-size');
    expect(result.notice).toMatch(/more rows match/i);
    expect(JSON.stringify(result).length).toBeLessThan(50_000);
  });

  // ISS-586 — label filter tests

  const LABEL_ID = '55555555-5555-4555-8555-555555555555';
  const LABEL_ID_2 = '66666666-6666-4666-8666-666666666666';

  it('list filters.label (uuid) pushes the EXISTS join and returns matching issues', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // 1. resolveProjectIdFromSlug
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // 3. issue list (uuid filter → no name-resolution query)
    selectLimit.mockResolvedValueOnce([baseIssueRow]);

    const result = (await tool.handler({
      action: 'list',
      filters: { label: LABEL_ID },
    })) as { issues: Array<{ documentId: string }> };

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.documentId).toBe(ISSUE_ID);
  });

  it('list filters.label (name) resolves via labels query then returns matching issues', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // 1. resolveProjectIdFromSlug
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // 3. label name resolution: returns one resolved id
    selectLimit.mockResolvedValueOnce([{ id: LABEL_ID }]);
    // 4. issue list
    selectLimit.mockResolvedValueOnce([baseIssueRow]);

    const result = (await tool.handler({
      action: 'list',
      filters: { label: 'bug' },
    })) as { issues: Array<{ documentId: string }> };

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.documentId).toBe(ISSUE_ID);
  });

  it('list filters.label with unknown name short-circuits to empty without querying issues', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // 1. resolveProjectIdFromSlug
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // 3. label name resolution: unknown → no rows
    selectLimit.mockResolvedValueOnce([]);
    // Note: NO 4th mock — if the handler queries issues after this it gets undefined (test failure).

    const result = (await tool.handler({
      action: 'list',
      filters: { label: 'nonexistent-label' },
    })) as { issues: unknown[]; returned: number; limit: number; hasMore: boolean };

    expect(result).toMatchObject({ issues: [], returned: 0, limit: 25, hasMore: false });
  });

  it('list filters.label array mixes uuid and name, deduplicates resolved ids', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // 1. resolveProjectIdFromSlug
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // 3. name resolution returns LABEL_ID (the same uuid already in uuidValues → deduped)
    selectLimit.mockResolvedValueOnce([{ id: LABEL_ID }, { id: LABEL_ID_2 }]);
    // 4. issue list
    selectLimit.mockResolvedValueOnce([baseIssueRow]);

    const result = (await tool.handler({
      action: 'list',
      filters: { label: [LABEL_ID, 'enhancement'] },
    })) as { issues: Array<{ documentId: string }> };

    expect(result.issues).toHaveLength(1);
  });

  it('list throws BAD_REQUEST when no slug and no projectId', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: null,
    });
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('list throws NOT_FOUND when slug resolves to no project', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: 'unknown',
    });
    selectLimit.mockResolvedValueOnce([]); // no project for slug
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('get throws BAD_REQUEST without documentId', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    await expect(tool.handler({ action: 'get' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('get returns serialized issue when device owner is member', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // 1. loadIssue → issues row
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // 2. assertDeviceOwnerIsMember → project owner row (owned by device.ownerId)
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as {
      documentId: string;
      issueId: string;
      status: string;
    };
    expect(result.documentId).toBe(ISSUE_ID);
    expect(result.issueId).toBe('ISS-1');
    expect(result.status).toBe('open');
  });

  it('get attaches the issue attachments[] from the join', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    listIssueAttachmentsMock.mockResolvedValueOnce([
      {
        id: 'att-1',
        name: 'repro.png',
        mime: 'image/png',
        size: 42,
        url: '/api/attachments/att-1/download',
        createdAt: new Date(),
      },
    ]);

    const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as {
      attachments: Array<{ id: string; url: string; mime: string }>;
    };
    expect(listIssueAttachmentsMock).toHaveBeenCalledWith(ISSUE_ID);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.id).toBe('att-1');
    expect(result.attachments[0]?.url).toBe('/api/attachments/att-1/download');
  });

  it('get answers not-found when the caller is not a project member', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // effective-role lookup: project exists, caller has no role
    selectLimit.mockResolvedValueOnce([{ orgId: ORG_ID, memberRole: null, orgRole: null }]);

    await expect(tool.handler({ action: 'get', documentId: ISSUE_ID })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  it('get with fields returns only documentId + issueId + requested fields', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    const rowWithPlan = {
      ...baseIssueRow,
      plan: 'the implementation plan',
      description: 'some description',
    };
    selectLimit.mockResolvedValueOnce([rowWithPlan]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    const result = (await tool.handler({
      action: 'get',
      documentId: ISSUE_ID,
      fields: ['plan'],
    })) as Record<string, unknown>;

    // Identity fields always present
    expect(result.documentId).toBe(ISSUE_ID);
    expect(result.issueId).toBe('ISS-1');
    // Requested field present
    expect(result.plan).toBe('the implementation plan');
    // Un-requested heavy field absent
    expect(result.description).toBeUndefined();
    // Light scalar fields absent (not requested, not identity)
    expect(result.status).toBeUndefined();
    // Attachments absent (field-selective path skips attachment join)
    expect(result.attachments).toBeUndefined();
    // listIssueAttachments should NOT be called in the fields path
    expect(listIssueAttachmentsMock).not.toHaveBeenCalled();
  });

  it('get with multiple fields returns all of them', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    const rowWithFields = {
      ...baseIssueRow,
      plan: 'the plan',
      acceptanceCriteria: 'AC content',
      description: 'desc',
    };
    selectLimit.mockResolvedValueOnce([rowWithFields]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    const result = (await tool.handler({
      action: 'get',
      documentId: ISSUE_ID,
      fields: ['plan', 'acceptanceCriteria'],
    })) as Record<string, unknown>;

    expect(result.documentId).toBe(ISSUE_ID);
    expect(result.plan).toBe('the plan');
    // acceptanceCriteria is framed via markUntrusted — just verify it is present and contains the value
    expect(String(result.acceptanceCriteria)).toContain('AC content');
    expect(result.description).toBeUndefined();
  });

  it('get without fields stays backwards-compatible (full body + attachments)', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, plan: 'a plan' }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as Record<
      string,
      unknown
    >;

    // Full body: status and other scalars present
    expect(result.status).toBe('open');
    // Attachments join runs in the full path
    expect(listIssueAttachmentsMock).toHaveBeenCalledWith(ISSUE_ID);
    expect(result.attachments).toEqual([]);
    // bodyTruncated NOT set (that is only for step_start lean path)
    expect(result.bodyTruncated).toBeUndefined();
  });

  it('get with invalid field enum throws validation error', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });

    await expect(
      tool.handler({
        action: 'get',
        documentId: ISSUE_ID,
        fields: ['invalidField' as unknown as 'plan'],
      }),
    ).rejects.toThrow();
  });

  it('create requires data.title', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    await expect(tool.handler({ action: 'create', data: {} })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('create persists plan + acceptanceCriteria on the new row', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // resolve slug → project
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // membership check
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // insert returns row
    insertReturning.mockResolvedValueOnce([
      { ...baseIssueRow, plan: 'p1', acceptanceCriteria: 'ac1' },
    ]);

    const result = (await tool.handler({
      action: 'create',
      data: { title: 'New', plan: 'p1', acceptanceCriteria: 'ac1' },
    })) as { plan: string | null; acceptanceCriteria: string | null };

    // ISS-532: plan is agent-authored → char-strip only (unchanged here);
    // acceptanceCriteria is human-authored → framed as untrusted DATA in the
    // agent-facing serialization (raw value still stored, asserted below).
    expect(result.plan).toBe('p1');
    expect(result.acceptanceCriteria).toContain('ac1');
    expect(result.acceptanceCriteria).toContain('UNTRUSTED_DATA source="issue.acceptanceCriteria"');
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New', plan: 'p1', acceptanceCriteria: 'ac1' }),
    );
  });

  it('create accepts status: on_hold and emits issueCreated with that status (ISS-130)', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    insertReturning.mockResolvedValueOnce([{ ...baseIssueRow, status: 'on_hold' }]);

    const { hooks } = await import('../../pipeline/hooks.js');

    const result = (await tool.handler({
      action: 'create',
      data: { title: 'parked child', status: 'on_hold' },
    })) as { status: string };

    expect(result.status).toBe('on_hold');
    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'on_hold' }));
    expect(hooks.emit).toHaveBeenCalledWith(
      'issueCreated',
      expect.objectContaining({ status: 'on_hold' }),
    );
  });

  it('create rejects status outside the {open, on_hold, draft} allow-list (ISS-130, ISS-236)', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    await expect(
      tool.handler({
        action: 'create',
        data: { title: 'should fail', status: 'in_progress' },
      }),
    ).rejects.toThrow(/BAD_REQUEST/);
    expect(txInsertValues).not.toHaveBeenCalled();
  });

  // ISS-236 — drafts are AI-generated proposals; the create allow-list
  // accepts them so Dream / Doc-Sync schedules can deposit findings.
  it('create accepts status: draft and emits issueCreated with that status (ISS-236)', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    insertReturning.mockResolvedValueOnce([{ ...baseIssueRow, status: 'draft' }]);

    const { hooks } = await import('../../pipeline/hooks.js');

    const result = (await tool.handler({
      action: 'create',
      data: { title: 'AI proposal', status: 'draft' },
    })) as { status: string };

    expect(result.status).toBe('draft');
    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
    expect(hooks.emit).toHaveBeenCalledWith(
      'issueCreated',
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('create defaults status to open when omitted and emits issueCreated accordingly', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    insertReturning.mockResolvedValueOnce([baseIssueRow]);

    const { hooks } = await import('../../pipeline/hooks.js');

    await tool.handler({
      action: 'create',
      data: { title: 'normal create' },
    });

    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }));
    expect(hooks.emit).toHaveBeenCalledWith(
      'issueCreated',
      expect.objectContaining({ status: 'open' }),
    );
  });

  // ISS-571 — atomic relations on create
  describe('create with relations', () => {
    const BLOCKER_ID = '77777777-7777-4777-8777-777777777777';
    const BLOCKED_ID = '88888888-8888-4888-8888-888888888888';

    it('commits the dependsOnId edge BEFORE hooks.emit(issueCreated)', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]); // resolveProjectIdFromSlug
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      insertReturning.mockResolvedValueOnce([baseIssueRow]); // issue insert

      const { hooks } = await import('../../pipeline/hooks.js');
      const callOrder: string[] = [];
      setEdgeMock.mockImplementationOnce(async () => {
        callOrder.push('setDep');
        return { id: 'dep-id-1', created: true, updated: false, effect: 'added' as const };
      });
      vi.mocked(hooks.emit).mockImplementationOnce(async (topic) => {
        callOrder.push('issueCreated');
        return { topic, delivered: 1, failures: [] };
      });

      await tool.handler({
        action: 'create',
        data: {
          title: 'blocked issue',
          relations: [{ dependsOnId: BLOCKER_ID, kind: 'blocks' }],
        },
      });

      // edge must be committed before the hook fires
      expect(callOrder).toEqual(['setDep', 'issueCreated']);
      expect(setEdgeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          fromIssueId: BLOCKER_ID,
          toIssueId: ISSUE_ID,
          kind: 'blocks',
        }),
        {
          actor: { type: 'device', id: fakePrincipal.tokenId, agency: 'agent' },
          createdById: OWNER_ID,
        },
        expect.anything(),
      );
    });

    it('commits a blocksId edge with the new issue on the blocking side', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      insertReturning.mockResolvedValueOnce([baseIssueRow]);

      await tool.handler({
        action: 'create',
        data: {
          title: 'blocking issue',
          relations: [{ blocksId: BLOCKED_ID, kind: 'blocks' }],
        },
      });

      expect(setEdgeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: PROJECT_ID,
          fromIssueId: ISSUE_ID,
          toIssueId: BLOCKED_ID,
          kind: 'blocks',
        }),
        {
          actor: { type: 'device', id: fakePrincipal.tokenId, agency: 'agent' },
          createdById: OWNER_ID,
        },
        expect.anything(),
      );
    });

    it('create without relations writes no edge (backward compat)', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      insertReturning.mockResolvedValueOnce([baseIssueRow]);

      await tool.handler({ action: 'create', data: { title: 'plain issue' } });

      expect(setEdgeMock).not.toHaveBeenCalled();
    });

    it('rejects a relation with both dependsOnId and blocksId set', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({
          action: 'create',
          data: {
            title: 'bad relation',
            relations: [{ dependsOnId: BLOCKER_ID, blocksId: BLOCKED_ID, kind: 'blocks' }],
          } as unknown as Record<string, unknown>,
        }),
      ).rejects.toThrow();
      expect(setEdgeMock).not.toHaveBeenCalled();
    });

    it('rejects a relation with neither dependsOnId nor blocksId set', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({
          action: 'create',
          data: {
            title: 'bad relation',
            relations: [{ kind: 'blocks' }],
          } as unknown as Record<string, unknown>,
        }),
      ).rejects.toThrow();
      expect(setEdgeMock).not.toHaveBeenCalled();
    });

    it('rejects a relation with kind=decomposes (must use forge_project_pm instead)', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({
          action: 'create',
          data: {
            title: 'bad kind',
            relations: [{ dependsOnId: BLOCKER_ID, kind: 'decomposes' }],
          } as unknown as Record<string, unknown>,
        }),
      ).rejects.toThrow();
      expect(setEdgeMock).not.toHaveBeenCalled();
    });

    it('propagates an edge-write error and does not emit issueCreated', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      insertReturning.mockResolvedValueOnce([baseIssueRow]);

      const { hooks } = await import('../../pipeline/hooks.js');
      setEdgeMock.mockRejectedValueOnce(
        new Error('CYCLE_DETECTED: adding this blocks edge would form a loop'),
      );

      await expect(
        tool.handler({
          action: 'create',
          data: { title: 'cyclic issue', relations: [{ dependsOnId: BLOCKER_ID, kind: 'blocks' }] },
        }),
      ).rejects.toThrow(/CYCLE_DETECTED/);

      expect(hooks.emit).not.toHaveBeenCalledWith('issueCreated', expect.anything());
    });
  });

  describe('create with attachments', () => {
    const TINY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const TINY_B64 = TINY_BYTES.toString('base64');

    function makeAttachmentRow(index: number) {
      return {
        id: `aaaa${index}aaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
        issueId: ISSUE_ID,
        uploaderId: OWNER_ID,
        name: `screenshot-${index}.png`,
        mime: 'image/png',
        size: 4,
        createdAt: new Date(),
      };
    }

    it('persists a single attachment and returns its url', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]); // resolveProjectIdFromSlug
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      insertReturning.mockResolvedValueOnce([baseIssueRow]); // issue insert
      insertReturning.mockResolvedValueOnce([makeAttachmentRow(0)]); // attachment insert

      const result = (await tool.handler({
        action: 'create',
        data: {
          title: 'with screenshot',
          attachments: [{ name: 'screenshot-0.png', mime: 'image/png', dataBase64: TINY_B64 }],
        },
      })) as {
        documentId: string;
        attachments: Array<{ id: string; url: string; mime: string; size: number }>;
        attachmentErrors?: unknown;
      };

      expect(result.documentId).toBe(ISSUE_ID);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.url).toMatch(/^\/api\/attachments\/.+\/download$/);
      expect(result.attachmentErrors).toBeUndefined();
      expect(storagePut).toHaveBeenCalledTimes(1);
      const putKey = storagePut.mock.calls[0]?.[0] ?? '';
      expect(putKey).toMatch(new RegExp(`^issues/${ISSUE_ID}/\\d+-screenshot-0\\.png$`));
    });

    it('rejects PAYLOAD_TOO_LARGE before inserting the issue', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);

      const fourMb = Buffer.alloc(4 * 1024 * 1024, 7);
      const b64 = fourMb.toString('base64');

      await expect(
        tool.handler({
          action: 'create',
          data: {
            title: 'too big',
            attachments: [
              { name: 'a.png', mime: 'image/png', dataBase64: b64 },
              { name: 'b.png', mime: 'image/png', dataBase64: b64 },
              { name: 'c.png', mime: 'image/png', dataBase64: b64 },
            ],
          },
        }),
      ).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
      expect(insertReturning).not.toHaveBeenCalled();
    });

    it('rejects INVALID_BASE64 before inserting the issue', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);

      await expect(
        tool.handler({
          action: 'create',
          data: {
            title: 'bad b64',
            attachments: [{ name: 'a.png', mime: 'image/png', dataBase64: '!!!not-base64!!!' }],
          },
        }),
      ).rejects.toThrow(/INVALID_BASE64/);
      expect(insertReturning).not.toHaveBeenCalled();
    });

    it('returns MIME_NOT_ALLOWED in attachmentErrors and keeps the issue', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      insertReturning.mockResolvedValueOnce([baseIssueRow]); // issue insert succeeds

      const result = (await tool.handler({
        action: 'create',
        data: {
          title: 'bad mime',
          attachments: [
            { name: 'bad.exe', mime: 'application/x-msdownload', dataBase64: TINY_B64 },
          ],
        },
      })) as {
        documentId: string;
        attachments: unknown[];
        attachmentErrors: Array<{ code: string; index: number }>;
      };

      expect(result.documentId).toBe(ISSUE_ID);
      expect(result.attachments).toEqual([]);
      expect(result.attachmentErrors).toHaveLength(1);
      expect(result.attachmentErrors[0]?.code).toBe('MIME_NOT_ALLOWED');
    });
  });

  it('update writes plan and bumps updatedAt', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership check
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // re-load fresh after update
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, plan: 'new plan' }]);

    const result = (await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { plan: 'new plan' },
    })) as { plan: string | null; status: string };

    expect(result.plan).toBe('new plan');
    expect(updateIssueFieldsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: ISSUE_ID,
        updates: expect.objectContaining({ plan: 'new plan', updatedAt: expect.anything() }),
      }),
    );
  });

  it('update with status routes through state machine and rejects illegal transition', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue (status=open)
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership check
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    // open → draft is illegal (draft is never a runtime transition target;
    // all other transitions are now permissive — guided by the system prompt)
    await expect(
      tool.handler({
        action: 'update',
        documentId: ISSUE_ID,
        data: { status: 'draft' },
      }),
    ).rejects.toThrow(/ILLEGAL_TRANSITION/);
  });

  // cm:guard `unblock` is GONE from the schema (RFC 0002 INV-6) — the three tests deleted from this spot asserted that a park exit needs a sentinel to dispatch. `.strict()` is what makes this fail loudly instead of ignoring the field, which is how the same flag was silently dropped by the `transition` action for two days (ISS-671/813/825/831, one stranded 48h).
  it('rejects the removed data.unblock flag instead of ignoring it', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    await expect(
      tool.handler({
        action: 'transition',
        documentId: ISSUE_ID,
        data: { status: 'tested', unblock: true },
      }),
    ).rejects.toThrow();
  });

  // cm:guard a reopen through MCP must be REJECTED without a reason (INV-8) — this is the only enforcement point an agent meets, and the three dispatch-side guards that used to detect a reasonless reopen afterwards are all deleted
  // cm:guard the agent surface is held to the same bar as REST — an MCP path that accepts a reasonless park is the whole requirement defeated, because agents are what produce nearly all of them
  it.each([
    ['reopen', 'tested'],
    ['waiting', 'in_progress'],
    ['needs_info', 'open'],
  ])('rejects a %s with no reason and no note', async (to, from) => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, status: from }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    await expect(
      tool.handler({ action: 'transition', documentId: ISSUE_ID, data: { status: to } }),
    ).rejects.toThrow(/TRANSITION_REASON_REQUIRED/);
  });

  it('rejects a `waiting` park that states a reason but no kind', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, status: 'in_progress' as const }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);

    await expect(
      tool.handler({
        action: 'transition',
        documentId: ISSUE_ID,
        data: { status: 'waiting', reason: 'need the staging DB password' },
      }),
    ).rejects.toThrow(/WAITING_KIND_REQUIRED/);
  });

  it('accepts a reopen whose rationale arrives as `note`', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    const testedRow = { ...baseIssueRow, status: 'tested' as const };
    selectLimit.mockResolvedValueOnce([testedRow]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // cm:why the third read is the project's pipeline mode: a `reopen` on an autonomous project is rewritten to `open` before the write (issues/autonomous-park.ts), and an empty agentConfig is the staged answer that leaves this transition alone
    selectLimit.mockResolvedValueOnce([{ agentConfig: {} }]);
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, reopenCount: 1, updatedAt: new Date() },
    ]);
    selectLimit.mockResolvedValueOnce([{ ...testedRow, status: 'reopen' }]);

    const out = (await tool.handler({
      action: 'transition',
      documentId: ISSUE_ID,
      data: { status: 'reopen', note: 'live checkout 500s on the payment step' },
    })) as Record<string, unknown>;
    expect(out.status).toBe('reopen');
  });

  it('transition open→confirmed updates status and emits hook', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue (open)
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    // conditional UPDATE returning the new row
    updateReturning.mockResolvedValueOnce([
      { id: ISSUE_ID, reopenCount: 0, updatedAt: new Date() },
    ]);
    // re-load fresh
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, status: 'confirmed' }]);

    const result = (await tool.handler({
      action: 'transition',
      documentId: ISSUE_ID,
      data: { status: 'confirmed' },
    })) as { status: string };

    expect(result.status).toBe('confirmed');
  });

  // ISS-199 — typed releaseNotes round-trip + zod rejection.

  it('create persists releaseNotes and serializes them on the response', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    const rn = {
      section: 'Fixed' as const,
      userFacing: 'Logging in no longer logs you out instantly.',
      technical: 'Cookie SameSite=None required after the cross-site redirect.',
    };
    insertReturning.mockResolvedValueOnce([{ ...baseIssueRow, releaseNotes: rn }]);

    const result = (await tool.handler({
      action: 'create',
      data: { title: 'Login bug', releaseNotes: rn },
    })) as { releaseNotes: typeof rn | null };

    expect(result.releaseNotes).toEqual(rn);
    expect(txInsertValues).toHaveBeenCalledWith(expect.objectContaining({ releaseNotes: rn }));
  });

  it('update writes releaseNotes onto an existing issue', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    const rn = { section: 'Added' as const, userFacing: 'You can now export issues to CSV.' };
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, releaseNotes: rn }]);

    const result = (await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { releaseNotes: rn },
    })) as { releaseNotes: typeof rn | null };

    expect(result.releaseNotes).toEqual(rn);
    expect(updateIssueFieldsMock).toHaveBeenCalledWith(
      expect.objectContaining({ updates: expect.objectContaining({ releaseNotes: rn }) }),
    );
  });

  it('update rejects releaseNotes with an invalid section enum', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    await expect(
      tool.handler({
        action: 'update',
        documentId: ISSUE_ID,
        data: { releaseNotes: { section: 'Bogus', userFacing: 'x' } } as unknown as Record<
          string,
          unknown
        >,
      }),
    ).rejects.toThrow();
  });

  it('transition surfaces STALE_TRANSITION when conditional update returns no row', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    updateReturning.mockResolvedValueOnce([]);

    await expect(
      tool.handler({
        action: 'transition',
        documentId: ISSUE_ID,
        data: { status: 'confirmed' },
      }),
    ).rejects.toThrow(/STALE_TRANSITION/);
  });

  // ISS-150 cross-tenant scope tests — regression coverage for the PAT
  // projectIds allowlist enforcement on documentId-resolved access. These
  // are the tests whose absence let Finding #1 land.
  describe('PAT projectIds allowlist (cross-tenant)', () => {
    const PAT_USER = OWNER_ID;
    const PAT_TOKEN = '55555555-5555-4555-8555-555555555555';
    const ALLOWED_PROJECT = '66666666-6666-4666-8666-666666666666';

    function makePatTool(projectIds: string[] | null) {
      return forgeIssuesTool({
        principal: humanPat(PAT_USER, PAT_TOKEN, projectIds),
        projectSlug: null,
      });
    }

    it("get returns NOT_FOUND when issue's project is outside PAT allowlist (even if user is a member)", async () => {
      // PAT scoped to ALLOWED_PROJECT — but the documentId points at PROJECT_ID.
      const tool = makePatTool([ALLOWED_PROJECT]);
      // loadIssue resolves the project from the documentId.
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      // No further DB calls should be made: the allowlist check rejects first.
      await expect(tool.handler({ action: 'get', documentId: ISSUE_ID })).rejects.toThrow(
        /NOT_FOUND/,
      );
    });

    it("update rejects with NOT_FOUND when issue's project is outside PAT allowlist", async () => {
      const tool = makePatTool([ALLOWED_PROJECT]);
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      await expect(
        tool.handler({
          action: 'update',
          documentId: ISSUE_ID,
          data: { title: 'hijack' },
        }),
      ).rejects.toThrow(/NOT_FOUND/);
    });

    it("transition rejects with NOT_FOUND when issue's project is outside PAT allowlist", async () => {
      const tool = makePatTool([ALLOWED_PROJECT]);
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      await expect(
        tool.handler({
          action: 'transition',
          documentId: ISSUE_ID,
          data: { status: 'confirmed' },
        }),
      ).rejects.toThrow(/NOT_FOUND/);
    });

    it('get succeeds when PAT projectIds is null (no allowlist) and user is a project owner', async () => {
      const tool = makePatTool(null);
      // loadIssue
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      // assertPrincipalIsMember (PAT path) → effective-role lookup
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as {
        documentId: string;
      };
      expect(result.documentId).toBe(ISSUE_ID);
    });

    it("get succeeds when PAT projectIds includes the issue's project", async () => {
      const tool = makePatTool([PROJECT_ID]);
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      // PAT path still confirms the user is a member of the project.
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as {
        documentId: string;
      };
      expect(result.documentId).toBe(ISSUE_ID);
    });
  });

  // ISS-286 — explicit merge-marker actions.
  describe('mark_merged / unmark (ISS-286)', () => {
    const auditCommentRow = {
      id: '77777777-7777-4777-8777-777777777777',
      body: 'mark_merged target=feature',
      parentId: null,
    };
    const STAMPED = new Date('2026-05-30T00:00:00.000Z');

    it('mark_merged stamps merged_at via COALESCE, writes audit comment, and broadcasts', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssue (merged_at currently null)
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      // membership
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      // audit comment insert
      insertReturning.mockResolvedValueOnce([auditCommentRow]);
      // re-load fresh (now stamped)
      selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, mergedAt: STAMPED }]);

      const { hooks } = await import('../../pipeline/hooks.js');

      const result = (await tool.handler({
        action: 'mark_merged',
        data: { issueId: ISSUE_ID, target: 'feature', note: 'merged @abc123' },
      })) as { mergedAt: Date | null; action: string };

      expect(result.action).toBe('merged');
      expect(result.mergedAt).toEqual(STAMPED);

      // Idempotency rests on COALESCE — assert the SQL shape (mock can't run
      // SQL), confirming the write is not an unconditional overwrite. The SQL
      // object embeds the column (circular), so read the literal StringChunks
      // out of queryChunks rather than JSON.stringify-ing the whole object.
      const setArg = updateSet.mock.calls[0]?.[0] as {
        mergedAt: { queryChunks?: Array<{ value?: unknown }> };
      };
      const literal = (setArg.mergedAt.queryChunks ?? [])
        .map((c) => (Array.isArray(c?.value) ? c.value.join('') : ''))
        .join('');
      expect(literal).toMatch(/coalesce/i);

      // audit comment on the issue
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: ISSUE_ID,
          authorId: OWNER_ID,
          body: expect.stringContaining('mark_merged target=feature'),
        }),
      );
      expect(hooks.emit).toHaveBeenCalledWith(
        'commentCreated',
        expect.objectContaining({ issueId: ISSUE_ID, commentId: auditCommentRow.id }),
      );
      // WS issue broadcast with mergedAt field
      expect(hooks.emit).toHaveBeenCalledWith(
        'issueUpdated',
        expect.objectContaining({
          issueId: ISSUE_ID,
          fields: ['mergedAt'],
          before: { mergedAt: null },
          after: { mergedAt: STAMPED },
        }),
      );
    });

    it('mark_merged with explicit mergedAt binds an ISO string with a ::timestamptz cast', async () => {
      // Regression: a bare `sql`${date}`` binds an untyped param that Postgres
      // cannot type inside COALESCE (live 500 on forge-beta). The stamp must
      // be an ISO string carrying an explicit ::timestamptz cast.
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([baseIssueRow]); // loadIssue
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      insertReturning.mockResolvedValueOnce([auditCommentRow]); // audit comment
      selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, mergedAt: STAMPED }]); // fresh

      await tool.handler({
        action: 'mark_merged',
        data: { issueId: ISSUE_ID, target: 'prod', mergedAt: '2026-05-30T00:00:00.000Z' },
      });

      // The COALESCE wraps the stamp SQL as a NESTED sql object, so walk
      // queryChunks recursively: StringChunks (value:string[]) form the
      // literal, Params (value:scalar) are the bound values.
      // drizzle chunks are: StringChunk (value:string[] → SQL literal), nested
      // SQL (queryChunks), or a raw interpolated value (the bound param, stored
      // directly — a string/Date/Param, not wrapped).
      type Chunk = { value?: unknown; queryChunks?: Chunk[] };
      const walk = (node: Chunk | undefined): { literal: string; params: unknown[] } => {
        const out = { literal: '', params: [] as unknown[] };
        for (const c of (node?.queryChunks ?? []) as Array<Chunk | string>) {
          if (typeof c === 'string') {
            out.params.push(c);
          } else if (c?.queryChunks) {
            const inner = walk(c);
            out.literal += inner.literal;
            out.params.push(...inner.params);
          } else if (Array.isArray(c?.value)) {
            out.literal += c.value.join('');
          } else if (c?.value !== undefined) {
            out.params.push(c.value);
          }
        }
        return out;
      };
      const setArg = updateSet.mock.calls[0]?.[0] as { mergedAt: Chunk };
      const { literal, params } = walk(setArg.mergedAt);
      expect(literal).toMatch(/::timestamptz/i);
      // The bound param must be the ISO string, NOT a Date object — an untyped
      // Date param is exactly what failed type inference on real Postgres.
      expect(params).toContain('2026-05-30T00:00:00.000Z');
      expect(params.every((p) => !(p instanceof Date))).toBe(true);
    });

    it('mark_merged requires data.target', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({ action: 'mark_merged', data: { issueId: ISSUE_ID } }),
      ).rejects.toThrow(/BAD_REQUEST/);
    });

    it('mark_merged requires data.issueId', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({ action: 'mark_merged', data: { target: 'base' } }),
      ).rejects.toThrow(/BAD_REQUEST/);
    });

    it('unmark clears merged_at to NULL, writes audit comment, broadcasts, and does NOT tick', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssue (merged_at currently set)
      selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, mergedAt: STAMPED }]);
      // membership
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      // audit comment insert
      insertReturning.mockResolvedValueOnce([{ ...auditCommentRow, body: 'unmark' }]);
      // re-load fresh (cleared)
      selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, mergedAt: null }]);

      const { hooks } = await import('../../pipeline/hooks.js');

      const result = (await tool.handler({
        action: 'unmark',
        data: { issueId: ISSUE_ID, note: 'epic rolled back' },
      })) as { mergedAt: Date | null; action: string };

      expect(result.action).toBe('unmarked');
      expect(result.mergedAt).toBeNull();
      expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ mergedAt: null }));
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: ISSUE_ID, body: expect.stringContaining('unmark') }),
      );
      expect(hooks.emit).toHaveBeenCalledWith(
        'issueUpdated',
        expect.objectContaining({
          fields: ['mergedAt'],
          before: { mergedAt: STAMPED },
          after: { mergedAt: null },
        }),
      );
    });

    it('unmark requires data.issueId', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(tool.handler({ action: 'unmark', data: {} })).rejects.toThrow(/BAD_REQUEST/);
    });

    it('mark_merged rejects a non-member as not-found', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssue
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      // effective-role lookup: project exists, caller has no role
      selectLimit.mockResolvedValueOnce([{ orgId: ORG_ID, memberRole: null, orgRole: null }]);

      await expect(
        tool.handler({ action: 'mark_merged', data: { issueId: ISSUE_ID, target: 'base' } }),
      ).rejects.toThrow(/NOT_FOUND/);
    });

    it('mark_merged refuses an agent-held token with no recorded code evidence (ISS-75/76/77/78 shape)', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([baseIssueRow]); // loadIssue
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      findMissingWorkEvidenceMock.mockResolvedValueOnce(
        'no branch, commit or code handoff is recorded for this issue',
      );

      await expect(
        tool.handler({ action: 'mark_merged', data: { issueId: ISSUE_ID, target: 'base' } }),
      ).rejects.toThrow(/NO_WORK_EVIDENCE/);
      expect(updateSet).not.toHaveBeenCalled();
      expect(txInsertValues).not.toHaveBeenCalled();
    });

    it('mark_merged does NOT evidence-gate a PAT (human) principal', async () => {
      const tool = forgeIssuesTool({
        principal: humanPat(OWNER_ID, '55555555-5555-4555-8555-555555555555', null),
        projectSlug: PROJECT_SLUG,
      });
      findMissingWorkEvidenceMock.mockResolvedValueOnce('no evidence at all');
      selectLimit.mockResolvedValueOnce([baseIssueRow]); // loadIssue
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership/writer role
      insertReturning.mockResolvedValueOnce([auditCommentRow]); // audit comment
      selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, mergedAt: STAMPED }]); // fresh

      const result = (await tool.handler({
        action: 'mark_merged',
        data: { issueId: ISSUE_ID, target: 'base' },
      })) as { action: string };

      expect(result.action).toBe('merged');
      expect(findMissingWorkEvidenceMock).not.toHaveBeenCalled();
    });

    it("unmark rejects with NOT_FOUND when the issue's project is outside the PAT allowlist", async () => {
      const tool = forgeIssuesTool({
        principal: humanPat(OWNER_ID, '55555555-5555-4555-8555-555555555555', [
          '66666666-6666-4666-8666-666666666666',
        ]),
        projectSlug: null,
      });
      // loadIssue resolves a row whose project is NOT in the allowlist
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      await expect(tool.handler({ action: 'unmark', data: { issueId: ISSUE_ID } })).rejects.toThrow(
        /NOT_FOUND/,
      );
    });
  });

  // ISS-633 — plain label attach/detach via MCP (Phase 1: names or uuids,
  // REPLACE-SET semantics mirroring REST PATCH's labels behavior).
  describe('data.labels attach/detach (ISS-633)', () => {
    const OTHER_LABEL_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

    it('update resolves labels by NAME and by UUID and hands the ids to the update service', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      // cm:guard these four stagings pop off ONE shared queue in call order — loadIssue, membership, the single resolveLabelIdsForWrite query that answers both the uuid and the name, then the re-read; insert or drop a query anywhere in the handler and every later test in this file reads someone else's row
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      selectLimit.mockResolvedValueOnce([
        { id: LABEL_ID, name: 'bug' },
        { id: LABEL_ID_2, name: 'area:mobile' },
      ]);
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      listIssueLabelsMock.mockResolvedValueOnce([
        { id: LABEL_ID, name: 'bug', color: '#fff' },
        { id: LABEL_ID_2, name: 'area:mobile', color: '#000' },
      ]);

      const result = (await tool.handler({
        action: 'update',
        documentId: ISSUE_ID,
        data: { labels: [LABEL_ID, 'area:mobile'] },
      })) as { labels: Array<{ id: string }> };

      expect(result.labels).toHaveLength(2);
      // cm:edge contract -> packages/core/src/issues/update-service.ts — the replace-set delta (which ids are added, which removed, and the activity rows for both) is asserted there; this side asserts only that the resolved ids arrive
      const call = updateIssueFieldsMock.mock.lastCall?.[0];
      expect([...(call?.labelIds ?? [])].map((l) => l.labelId).sort()).toEqual(
        [LABEL_ID, LABEL_ID_2].sort(),
      );
      expect([...(call?.labelIds ?? [])].every((l) => l.isPrimary === false)).toBe(true);
      expect(call?.actor).toEqual({ type: 'device', id: fakePrincipal.tokenId, agency: 'agent' });
    });

    it('update with labels:[] passes an empty id set through as the clear-all request', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([baseIssueRow]); // loadIssue
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      // labels:[] short-circuits resolveLabelIdsForWrite — no label-name query
      selectLimit.mockResolvedValueOnce([baseIssueRow]); // re-load fresh
      listIssueLabelsMock.mockResolvedValueOnce([]);

      const result = (await tool.handler({
        action: 'update',
        documentId: ISSUE_ID,
        data: { labels: [] },
      })) as { labels: unknown[] };

      expect(result.labels).toEqual([]);
      // cm:guard `[]` must survive as `[]` and never collapse to `undefined` — the service reads undefined as "leave labels alone", which is the opposite of the clear-all this asserts
      expect(updateIssueFieldsMock.mock.lastCall?.[0]).toMatchObject({ labelIds: [] });
    });

    it('update rejects an unknown label name with BAD_REQUEST and performs no writes', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([baseIssueRow]); // loadIssue
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      selectLimit.mockResolvedValueOnce([]); // resolveLabelIdsForWrite — nothing matches

      await expect(
        tool.handler({
          action: 'update',
          documentId: ISSUE_ID,
          data: { labels: ['does-not-exist'] },
        }),
      ).rejects.toThrow(/BAD_REQUEST/);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('update rejects a label uuid that belongs to another project', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([baseIssueRow]); // loadIssue
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      // the uuid is scoped to issue.projectId in the query — a foreign-project
      // label id never matches, so the query returns no rows.
      selectLimit.mockResolvedValueOnce([]);

      await expect(
        tool.handler({
          action: 'update',
          documentId: ISSUE_ID,
          data: { labels: [OTHER_LABEL_ID] },
        }),
      ).rejects.toThrow(/BAD_REQUEST/);
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('create accepts data.labels, attaches them, and passes resolved ids to issueCreated snapshot.labels', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]); // resolveProjectIdFromSlug
      selectLimit.mockResolvedValueOnce([memberAccessRow]); // membership
      selectLimit.mockResolvedValueOnce([{ id: LABEL_ID, name: 'area:mobile' }]); // resolveLabelIdsForWrite
      insertReturning.mockResolvedValueOnce([baseIssueRow]); // issue insert
      listIssueLabelsMock.mockResolvedValueOnce([
        { id: LABEL_ID, name: 'area:mobile', color: '#000' },
      ]);

      const { hooks } = await import('../../pipeline/hooks.js');

      const result = (await tool.handler({
        action: 'create',
        data: { title: 'tagged issue', labels: ['area:mobile'] },
      })) as { labels: Array<{ id: string }> };

      expect(result.labels).toEqual([{ id: LABEL_ID, name: 'area:mobile', color: '#000' }]);
      expect(txInsertValues).toHaveBeenCalledWith(
        expect.arrayContaining([{ issueId: ISSUE_ID, labelId: LABEL_ID, isPrimary: false }]),
      );
      expect(hooks.emit).toHaveBeenCalledWith(
        'issueCreated',
        expect.objectContaining({ snapshot: expect.objectContaining({ labels: [LABEL_ID] }) }),
      );
    });

    it('create without data.labels attaches none and keeps snapshot.labels empty (backward compat)', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      insertReturning.mockResolvedValueOnce([baseIssueRow]);

      const { hooks } = await import('../../pipeline/hooks.js');

      const result = (await tool.handler({
        action: 'create',
        data: { title: 'plain issue' },
      })) as { labels: unknown[] };

      expect(result.labels).toEqual([]);
      expect(hooks.emit).toHaveBeenCalledWith(
        'issueCreated',
        expect.objectContaining({ snapshot: expect.objectContaining({ labels: [] }) }),
      );
    });

    it('get returns the issue current labels[]', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      listIssueLabelsMock.mockResolvedValueOnce([{ id: LABEL_ID, name: 'bug', color: '#f00' }]);

      const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as {
        labels: Array<{ id: string; name: string }>;
      };

      expect(result.labels).toEqual([{ id: LABEL_ID, name: 'bug', color: '#f00' }]);
    });

    it('list row omits labels (stays lean; use action=get for the label set)', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      selectLimit.mockResolvedValueOnce([baseIssueRow]);

      const result = (await tool.handler({ action: 'list' })) as {
        issues: Array<Record<string, unknown>>;
      };

      expect(result.issues[0]).not.toHaveProperty('labels');
      // listIssueLabels must never be queried on the list (browse) surface.
      expect(listIssueLabelsMock).not.toHaveBeenCalled();
    });
  });

  describe('task sub-actions (ISS-146)', () => {
    const TASK_ID = '66666666-6666-4666-8666-666666666666';
    const baseTaskRow = {
      id: TASK_ID,
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      title: 'Sub-task',
      description: null,
      status: 'backlog' as const,
      priority: 'none' as const,
      assigneeId: null,
      isAgentTask: false,
      agentStatus: null,
      acceptanceCriteria: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('createTask: inserts row with project resolved from parent issue', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssueProjectId
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      // assertPrincipalIsMember → project owner row
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      createTaskMock.mockResolvedValueOnce(baseTaskRow);

      const result = (await tool.handler({
        action: 'createTask',
        data: { issueId: ISSUE_ID, taskTitle: 'Sub-task' },
      })) as { task: { documentId: string; title: string; status: string } };

      expect(result.task.documentId).toBe(TASK_ID);
      expect(result.task.title).toBe('Sub-task');
      // cm:edge contract -> packages/core/src/tasks/task-service.ts — sortOrder and the taskCreated emit are asserted there; the tool owns resolving the project from the parent issue rather than trusting the caller for it
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: ISSUE_ID,
          projectId: PROJECT_ID,
          title: 'Sub-task',
          actor: { type: 'device', id: fakePrincipal.tokenId, agency: 'agent' },
        }),
      );
    });

    it('createTask: requires data.issueId', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({ action: 'createTask', data: { taskTitle: 'x' } }),
      ).rejects.toThrow(/BAD_REQUEST/);
    });

    it('createTask: requires data.taskTitle', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({ action: 'createTask', data: { issueId: ISSUE_ID } }),
      ).rejects.toThrow(/BAD_REQUEST/);
    });

    it('listTasks: returns serialized rows filtered by parent issue', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssueProjectId
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      // membership
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      listTasksForIssueMock.mockResolvedValueOnce([baseTaskRow] as never);

      const result = (await tool.handler({
        action: 'listTasks',
        filters: { issue: ISSUE_ID },
      })) as { tasks: Array<{ documentId: string }> };

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.documentId).toBe(TASK_ID);
    });

    it('listTasks: respects filters.taskStatus', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      listTasksForIssueMock.mockResolvedValueOnce([
        { ...baseTaskRow, status: 'in_progress' },
      ] as never);

      const result = (await tool.handler({
        action: 'listTasks',
        filters: { issue: ISSUE_ID, taskStatus: 'in_progress' },
      })) as { tasks: Array<{ status: string }> };
      expect(result.tasks[0]?.status).toBe('in_progress');
      expect(listTasksForIssueMock).toHaveBeenCalledWith(
        ISSUE_ID,
        expect.objectContaining({ status: 'in_progress' }),
      );
    });

    it('listTasks: requires filters.issue', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      await expect(tool.handler({ action: 'listTasks' })).rejects.toThrow(/BAD_REQUEST/);
    });

    it('listTasks: returned rows omit description field in serialization (ISS-562)', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      listTasksForIssueMock.mockResolvedValueOnce([
        { ...baseTaskRow, description: 'd'.repeat(1_000) },
      ] as never);

      const result = (await tool.handler({
        action: 'listTasks',
        filters: { issue: ISSUE_ID },
      })) as { tasks: Array<Record<string, unknown>> };

      expect(result.tasks[0]).not.toHaveProperty('description');
    });

    it('listTasks: returns truncated:true when fat rows exceed 38K chars (ISS-562)', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      // 50 fat task rows (title ~2KB each) — total well exceeds 38K
      const fatTaskRows = Array.from({ length: 50 }, (_, i) => ({
        ...baseTaskRow,
        id: `66666666-6666-4666-8666-66666666666${(i % 10).toString()}`,
        title: 't'.repeat(2_000),
      }));
      listTasksForIssueMock.mockResolvedValueOnce(fatTaskRows as never);

      const result = (await tool.handler({
        action: 'listTasks',
        filters: { issue: ISSUE_ID },
      })) as {
        tasks: unknown[];
        truncated: boolean;
        returned: number;
        limit: number;
        truncatedBy: string;
        notice: string;
      };

      expect(result.truncated).toBe(true);
      expect(result.returned).toBeLessThan(50);
      expect(result.limit).toBe(25);
      expect(result.truncatedBy).toBe('limit+response-size');
      expect(result.notice).toMatch(/more rows match/i);
      expect(JSON.stringify(result).length).toBeLessThan(50_000);
    });

    it('updateTask: patches mapped fields', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      findTaskByIdMock.mockResolvedValueOnce(baseTaskRow);
      // membership
      selectLimit.mockResolvedValueOnce([memberAccessRow]);
      updateTaskMock.mockResolvedValueOnce({ ...baseTaskRow, status: 'done' });

      const result = (await tool.handler({
        action: 'updateTask',
        documentId: TASK_ID,
        data: { taskStatus: 'done' },
      })) as { task: { status: string } };

      expect(result.task.status).toBe('done');
      // cm:edge contract -> packages/core/src/tasks/task-service.ts — the change diff and the taskUpdated emit are asserted there; this side asserts the agent-facing `taskStatus` maps onto the column name
      expect(updateTaskMock).toHaveBeenCalledWith(
        baseTaskRow,
        { status: 'done' },
        { type: 'device', id: fakePrincipal.tokenId, agency: 'agent' },
        ['acceptanceCriteria'],
      );
    });

    it('deleteTask: runs db.delete after membership check', async () => {
      const tool = forgeIssuesTool({
        principal: fakePrincipal,
        projectSlug: PROJECT_SLUG,
      });
      findTaskByIdMock.mockResolvedValueOnce(baseTaskRow);
      selectLimit.mockResolvedValueOnce([memberAccessRow]);

      const result = (await tool.handler({
        action: 'deleteTask',
        documentId: TASK_ID,
      })) as { deleted: boolean; documentId: string };

      expect(result.deleted).toBe(true);
      expect(result.documentId).toBe(TASK_ID);
      expect(deleteTaskMock).toHaveBeenCalledWith(baseTaskRow, {
        type: 'device',
        id: fakePrincipal.tokenId,
        agency: 'agent',
      });
    });
  });
});

describe('findVerifiedClaimViolation', () => {
  it('rejects a bare string verified* value', () => {
    const violation = findVerifiedClaimViolation({ verifiedGroundTruth: 'commit abc123 exists' });
    expect(violation?.path).toBe('verifiedGroundTruth');
  });

  it('rejects a bare boolean verified* value', () => {
    const violation = findVerifiedClaimViolation({ verified: true });
    expect(violation?.path).toBe('verified');
  });

  it('rejects a bare verified* value nested at any depth', () => {
    const violation = findVerifiedClaimViolation({
      purpose: { nested: { verifiedGroundTruth: 'trust me' } },
    });
    expect(violation?.path).toBe('purpose.nested.verifiedGroundTruth');
  });

  it('matches verified* case-insensitively', () => {
    const violation = findVerifiedClaimViolation({ VerifiedBy: 'me' });
    expect(violation?.path).toBe('VerifiedBy');
  });

  it('accepts a shaped verified* value with string evidence', () => {
    const violation = findVerifiedClaimViolation({
      purpose: {
        verifiedGroundTruth: {
          evidence: 'git show abc123 confirms the file',
          checkedAt: new Date().toISOString(),
        },
      },
    });
    expect(violation).toBeNull();
  });

  it('accepts a shaped verified* value with array evidence', () => {
    const violation = findVerifiedClaimViolation({
      verified: {
        evidence: ['git log output', 'grep output'],
        checkedAt: new Date().toISOString(),
      },
    });
    expect(violation).toBeNull();
  });

  it('rejects a shaped-looking value with a non-ISO checkedAt', () => {
    const violation = findVerifiedClaimViolation({
      verified: { evidence: 'some evidence', checkedAt: 'not a date' },
    });
    expect(violation?.path).toBe('verified');
  });

  it.each(['2026', '2026-03-05', 'March 5 2026'])(
    'rejects a loose date %s that Date.parse alone would accept',
    (checkedAt) => {
      const violation = findVerifiedClaimViolation({
        verified: { evidence: 'some evidence', checkedAt },
      });
      expect(violation?.path).toBe('verified');
    },
  );

  it('rejects an ISO-shaped checkedAt that is not a real instant', () => {
    const violation = findVerifiedClaimViolation({
      verified: { evidence: 'some evidence', checkedAt: '2026-13-45T99:99:99Z' },
    });
    expect(violation?.path).toBe('verified');
  });

  it('rejects a shaped-looking value with empty evidence', () => {
    const violation = findVerifiedClaimViolation({
      verified: { evidence: '', checkedAt: new Date().toISOString() },
    });
    expect(violation?.path).toBe('verified');
  });

  it('ignores keys that do not start with verified', () => {
    const violation = findVerifiedClaimViolation({ unverifiedClaim: 'still just a string' });
    expect(violation).toBeNull();
  });

  // cm:guard ISS-820 — bound-exceed on a pathological payload MUST accept (fail-open), never reject a legitimate large payload nor hang
  it('accepts without hanging when a pathological payload exceeds the node bound', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 120_000; i++) {
      wide[`key${i}`] = 'value';
    }
    wide.verifiedGroundTruth = 'bare string, but buried past the node bound';
    const violation = findVerifiedClaimViolation(wide);
    expect(violation).toBeNull();
  });

  // cm:guard ISS-820 — the node budget must stay out of reach of any payload the 200000-byte sessionContext refinement admits, or padding keys buy a free bare claim
  it('still catches a bare claim padded to the largest payload the size cap admits', () => {
    const padded: Record<string, unknown> = {};
    for (let i = 0; i < 10_050; i++) {
      padded[`k${i}`] = 'v';
    }
    padded.verifiedGroundTruth = 'bare';
    expect(JSON.stringify(padded).length).toBeLessThan(200_000);
    expect(findVerifiedClaimViolation(padded)?.path).toBe('verifiedGroundTruth');
  });

  it('accepts without hanging when a pathological payload exceeds the depth bound', () => {
    let deep: Record<string, unknown> = {
      verifiedGroundTruth: 'bare string, but past the depth bound',
    };
    for (let i = 0; i < 100; i++) {
      deep = { nested: deep };
    }
    const violation = findVerifiedClaimViolation(deep);
    expect(violation).toBeNull();
  });

  // cm:guard ISS-820 — depth prunes ONE subtree, never the whole walk: a single over-deep decoy key must not buy a bare sibling claim
  it('still checks siblings of an over-deep decoy branch', () => {
    let decoy: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 70; i++) {
      decoy = { nested: decoy };
    }
    const violation = findVerifiedClaimViolation({ decoy, verifiedGroundTruth: 'bare' });
    expect(violation?.path).toBe('verifiedGroundTruth');
  });

  it('rejects a bare verified* value inside an array', () => {
    const violation = findVerifiedClaimViolation({ items: [{ verifiedGroundTruth: 'bare' }] });
    expect(violation?.path).toBe('items[0].verifiedGroundTruth');
  });
});

describe('forge_issues create — sessionContext verified* wiring (ISS-820)', () => {
  it('rejects create when sessionContext carries a bare verified* claim', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });

    await expect(
      tool.handler({
        action: 'create',
        data: {
          title: 'x',
          sessionContext: { purpose: { verifiedGroundTruth: 'the owner has decided' } },
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts create when sessionContext verified* claim is properly shaped', async () => {
    const tool = forgeIssuesTool({
      principal: fakePrincipal,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([memberAccessRow]);
    insertReturning.mockResolvedValueOnce([{ ...baseIssueRow }]);

    await expect(
      tool.handler({
        action: 'create',
        data: {
          title: 'x',
          sessionContext: {
            verified: { evidence: 'git log confirms', checkedAt: new Date().toISOString() },
          },
        },
      }),
    ).resolves.toBeDefined();
  });
});
