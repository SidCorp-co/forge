import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// Drizzle query-builder mock — each chain step returns the next mock so we
// can program per-call return values via `mockResolvedValueOnce` and assert
// on the call arguments. Mirrors the pattern used in tasks/routes.test.ts.
const selectLimit = vi.fn();
const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));

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
const txInsertValues = vi.fn(async () => undefined);
const txInsert = vi.fn(() => ({ values: txInsertValues }));
// ISS-196 — `withActorContext` calls `tx.execute(SELECT set_config(...))`
// before the UPDATE; stub it so the in-memory db mock doesn't blow up.
const txExecute = vi.fn(async () => undefined);
// ISS-232 — `markMergedIfLeavingBase` issues a 2nd `tx.select(...).from
// (projects)...` to resolve `mergeStates`. Stub it as an empty resolve so
// the helper short-circuits with defaults under the in-memory db mock.
const txSelectLimit = vi.fn(async () => [] as unknown[]);
const txSelectWhere = vi.fn(() => ({ limit: txSelectLimit }));
const txSelectFrom = vi.fn(() => ({ where: txSelectWhere }));
const txSelect = vi.fn(() => ({ from: txSelectFrom }));
const txProxy = {
  update: txUpdate,
  insert: txInsert,
  execute: txExecute,
  select: txSelect,
};
const transactionMock = vi.fn(async (cb: (tx: typeof txProxy) => Promise<unknown>) => cb(txProxy));

const deleteWhere = vi.fn(async () => undefined);
const deleteFrom = vi.fn(() => ({ where: deleteWhere }));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
    delete: vi.fn(() => deleteFrom()),
    transaction: (cb: (tx: typeof txProxy) => Promise<unknown>) => transactionMock(cb),
  },
}));

vi.mock('../../pipeline/hooks.js', () => ({
  hooks: { emit: vi.fn().mockResolvedValue(undefined) },
}));

const dispatchTick = vi.fn();
vi.mock('../../jobs/dispatch-tick.js', () => ({
  dispatchTickForProject: (...args: unknown[]) => dispatchTick(...args),
}));

vi.mock('../../ws/server.js', () => ({
  roomManager: { publish: vi.fn() },
}));

const { forgeIssuesTool } = await import('./forge-issues.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_SLUG = 'forge-dev';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

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
  parentIssueId: null,
  reopenCount: 0,
  source: 'manual' as const,
  externalId: null,
  plan: null,
  acceptanceCriteria: null,
  suggestedSolution: null,
  sessionContext: null,
  aiSummary: null,
  aiSuggestedSolution: null,
  aiAcceptanceCriteria: null,
  aiConfidence: null,
  releaseNotes: null,
  mergedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('forge_issues tool', () => {
  it('rejects unknown action', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    await expect(
      tool.handler({ action: 'wat' } as unknown as Record<string, unknown>),
    ).rejects.toThrow();
  });

  it('list resolves projectId from slug header and enforces membership', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // 1. resolveProjectIdFromSlug → projects.id
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // 2. assertDeviceOwnerIsMember → projects.ownerId (matches device.ownerId)
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // 3. issue list query
    selectLimit.mockResolvedValueOnce([baseIssueRow]);

    const result = (await tool.handler({ action: 'list' })) as {
      issues: Array<{ documentId: string }>;
    };
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.documentId).toBe(ISSUE_ID);
  });

  it('list throws BAD_REQUEST when no slug and no projectId', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: null,
    });
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('list throws NOT_FOUND when slug resolves to no project', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: 'unknown',
    });
    selectLimit.mockResolvedValueOnce([]); // no project for slug
    await expect(tool.handler({ action: 'list' })).rejects.toThrow(/NOT_FOUND/);
  });

  it('get throws BAD_REQUEST without documentId', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    await expect(tool.handler({ action: 'get' })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('get returns serialized issue when device owner is member', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // 1. loadIssue → issues row
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // 2. assertDeviceOwnerIsMember → project owner row (owned by device.ownerId)
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);

    const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as {
      documentId: string;
      issueId: string;
      status: string;
    };
    expect(result.documentId).toBe(ISSUE_ID);
    expect(result.issueId).toBe('ISS-1');
    expect(result.status).toBe('open');
  });

  it('get throws FORBIDDEN when device owner is not a project member', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // project owned by someone else
    selectLimit.mockResolvedValueOnce([{ ownerId: 'someone-else' }]);
    // no project member row
    selectLimit.mockResolvedValueOnce([]);

    await expect(tool.handler({ action: 'get', documentId: ISSUE_ID })).rejects.toThrow(
      /FORBIDDEN/,
    );
  });

  it('create requires data.title', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    await expect(tool.handler({ action: 'create', data: {} })).rejects.toThrow(/BAD_REQUEST/);
  });

  it('create persists plan + acceptanceCriteria on the new row', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // resolve slug → project
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // insert returns row
    insertReturning.mockResolvedValueOnce([
      { ...baseIssueRow, plan: 'p1', acceptanceCriteria: 'ac1' },
    ]);

    const result = (await tool.handler({
      action: 'create',
      data: { title: 'New', plan: 'p1', acceptanceCriteria: 'ac1' },
    })) as { plan: string | null; acceptanceCriteria: string | null };

    expect(result.plan).toBe('p1');
    expect(result.acceptanceCriteria).toBe('ac1');
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New', plan: 'p1', acceptanceCriteria: 'ac1' }),
    );
  });

  it('create accepts status: on_hold and emits issueCreated with that status (ISS-130)', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    insertReturning.mockResolvedValueOnce([{ ...baseIssueRow, status: 'on_hold' }]);

    const { hooks } = await import('../../pipeline/hooks.js');

    const result = (await tool.handler({
      action: 'create',
      data: { title: 'parked child', status: 'on_hold' },
    })) as { status: string };

    expect(result.status).toBe('on_hold');
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'on_hold' }));
    expect(hooks.emit).toHaveBeenCalledWith(
      'issueCreated',
      expect.objectContaining({ status: 'on_hold' }),
    );
  });

  it('create rejects status outside the {open, on_hold, draft} allow-list (ISS-130, ISS-236)', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);

    await expect(
      tool.handler({
        action: 'create',
        data: { title: 'should fail', status: 'in_progress' },
      }),
    ).rejects.toThrow(/BAD_REQUEST/);
    expect(insertValues).not.toHaveBeenCalled();
  });

  // ISS-236 — drafts are AI-generated proposals; the create allow-list
  // accepts them so Dream / Doc-Sync schedules can deposit findings.
  it('create accepts status: draft and emits issueCreated with that status (ISS-236)', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    insertReturning.mockResolvedValueOnce([{ ...baseIssueRow, status: 'draft' }]);

    const { hooks } = await import('../../pipeline/hooks.js');

    const result = (await tool.handler({
      action: 'create',
      data: { title: 'AI proposal', status: 'draft' },
    })) as { status: string };

    expect(result.status).toBe('draft');
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
    expect(hooks.emit).toHaveBeenCalledWith(
      'issueCreated',
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('create defaults status to open when omitted and emits issueCreated accordingly', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    insertReturning.mockResolvedValueOnce([baseIssueRow]);

    const { hooks } = await import('../../pipeline/hooks.js');

    await tool.handler({
      action: 'create',
      data: { title: 'normal create' },
    });

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }));
    expect(hooks.emit).toHaveBeenCalledWith(
      'issueCreated',
      expect.objectContaining({ status: 'open' }),
    );
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
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]); // resolveProjectIdFromSlug
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]); // membership
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
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);

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
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);

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
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
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
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // re-load fresh after update
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, plan: 'new plan' }]);

    const result = (await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { plan: 'new plan' },
    })) as { plan: string | null; status: string };

    expect(result.plan).toBe('new plan');
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'new plan', updatedAt: expect.anything() }),
    );
  });

  it('update with manualHold journals an activity entry and emits issueUpdated', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue (manualHold currently false)
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: false }]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // re-load fresh after update
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: true }]);

    const { hooks } = await import('../../pipeline/hooks.js');

    await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { manualHold: true },
    });

    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue.manualHold.set' }),
    );
    expect(hooks.emit).toHaveBeenCalledWith(
      'issueUpdated',
      expect.objectContaining({
        issueId: ISSUE_ID,
        fields: ['manualHold'],
        before: { manualHold: false },
        after: { manualHold: true },
      }),
    );
    // ISS-133 — setting hold (false → true) must NOT tick.
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('update clearing manualHold (true → false) fires dispatchTickForProject (ISS-133)', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue (manualHold currently true)
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: true }]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // re-load fresh
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: false }]);

    await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { manualHold: false },
    });

    expect(dispatchTick).toHaveBeenCalledTimes(1);
    expect(dispatchTick).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('update with non-manualHold fields does NOT fire dispatchTickForProject (ISS-133)', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: false }]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // re-load fresh
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: false }]);

    await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { title: 'renamed', description: 'new desc', plan: 'new plan' },
    });

    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('update with manualHold no-op (value matches) skips activity + hook', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue (manualHold already true)
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: true }]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    // re-load fresh
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, manualHold: true }]);

    const { hooks } = await import('../../pipeline/hooks.js');

    await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { manualHold: true },
    });

    expect(txInsertValues).not.toHaveBeenCalled();
    expect(hooks.emit).not.toHaveBeenCalledWith(
      'issueUpdated',
      expect.objectContaining({ fields: ['manualHold'] }),
    );
    // ISS-133 — no transition means no tick.
    expect(dispatchTick).not.toHaveBeenCalled();
  });

  it('update with status routes through state machine and rejects illegal transition', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue (status=open)
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership check
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);

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

  it('transition open→confirmed updates status and emits hook', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    // loadIssue (open)
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    // membership
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
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

  it('create persists AI enrichment fields and serializes them in the response', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    insertReturning.mockResolvedValueOnce([
      {
        ...baseIssueRow,
        aiSummary: 'one-line summary',
        aiSuggestedSolution: 'do the thing',
        aiAcceptanceCriteria: ['ac one', 'ac two'],
        aiConfidence: 0.75,
      },
    ]);

    const result = (await tool.handler({
      action: 'create',
      data: {
        title: 'Enriched',
        aiSummary: 'one-line summary',
        aiSuggestedSolution: 'do the thing',
        aiAcceptanceCriteria: ['ac one', 'ac two'],
        aiConfidence: 0.75,
      },
    })) as {
      aiSummary: string | null;
      aiSuggestedSolution: string | null;
      aiAcceptanceCriteria: string[] | null;
      aiConfidence: number | null;
    };

    expect(result.aiSummary).toBe('one-line summary');
    expect(result.aiSuggestedSolution).toBe('do the thing');
    expect(result.aiAcceptanceCriteria).toEqual(['ac one', 'ac two']);
    expect(result.aiConfidence).toBe(0.75);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSummary: 'one-line summary',
        aiSuggestedSolution: 'do the thing',
        aiAcceptanceCriteria: ['ac one', 'ac two'],
        aiConfidence: 0.75,
      }),
    );
  });

  it('update writes AI enrichment fields onto an existing issue', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    selectLimit.mockResolvedValueOnce([
      {
        ...baseIssueRow,
        aiSummary: 'updated summary',
        aiAcceptanceCriteria: ['x'],
        aiConfidence: 0.9,
      },
    ]);

    const result = (await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: {
        aiSummary: 'updated summary',
        aiAcceptanceCriteria: ['x'],
        aiConfidence: 0.9,
      },
    })) as {
      aiSummary: string | null;
      aiAcceptanceCriteria: string[] | null;
      aiConfidence: number | null;
    };

    expect(result.aiSummary).toBe('updated summary');
    expect(result.aiAcceptanceCriteria).toEqual(['x']);
    expect(result.aiConfidence).toBe(0.9);
    expect(txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSummary: 'updated summary',
        aiAcceptanceCriteria: ['x'],
        aiConfidence: 0.9,
      }),
    );
  });

  // ISS-199 — typed releaseNotes round-trip + zod rejection.

  it('create persists releaseNotes and serializes them on the response', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([{ id: PROJECT_ID }]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
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
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ releaseNotes: rn }));
  });

  it('update writes releaseNotes onto an existing issue', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
    const rn = { section: 'Added' as const, userFacing: 'You can now export issues to CSV.' };
    selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, releaseNotes: rn }]);

    const result = (await tool.handler({
      action: 'update',
      documentId: ISSUE_ID,
      data: { releaseNotes: rn },
    })) as { releaseNotes: typeof rn | null };

    expect(result.releaseNotes).toEqual(rn);
    expect(txUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ releaseNotes: rn }));
  });

  it('update rejects releaseNotes with an invalid section enum', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
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

  it('update rejects aiConfidence outside [0,1]', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    await expect(
      tool.handler({
        action: 'update',
        documentId: ISSUE_ID,
        data: { aiConfidence: 1.5 },
      }),
    ).rejects.toThrow();
  });

  it('transition surfaces STALE_TRANSITION when conditional update returns no row', async () => {
    const tool = forgeIssuesTool({
      principal: { kind: 'device', device: fakeDevice },
      device: fakeDevice,
      projectSlug: PROJECT_SLUG,
    });
    selectLimit.mockResolvedValueOnce([baseIssueRow]);
    selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
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
        principal: {
          kind: 'pat',
          userId: PAT_USER,
          tokenId: PAT_TOKEN,
          scopes: ['read', 'write'],
          projectIds,
        },
        device: fakeDevice,
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
      // assertPrincipalIsMember (PAT path) → loadUserProjectRole → projects lookup
      selectLimit.mockResolvedValueOnce([{ ownerId: PAT_USER }]);
      const result = (await tool.handler({ action: 'get', documentId: ISSUE_ID })) as {
        documentId: string;
      };
      expect(result.documentId).toBe(ISSUE_ID);
    });

    it("get succeeds when PAT projectIds includes the issue's project", async () => {
      const tool = makePatTool([PROJECT_ID]);
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      // PAT path still confirms the user is a member of the project.
      selectLimit.mockResolvedValueOnce([{ ownerId: PAT_USER }]);
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

    it('mark_merged stamps merged_at via COALESCE, writes audit comment, broadcasts, and ticks', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssue (merged_at currently null)
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      // membership
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
      // audit comment insert
      insertReturning.mockResolvedValueOnce([auditCommentRow]);
      // re-load fresh (now stamped)
      selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, mergedAt: STAMPED }]);

      const { hooks } = await import('../../pipeline/hooks.js');

      const result = (await tool.handler({
        action: 'mark_merged',
        data: { issueId: ISSUE_ID, target: 'feature', note: 'merged @abc123' },
      })) as { mergedAt: Date | null; status: string };

      expect(result.status).toBe('merged');
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
      // dispatcher wake so the now-unblocked parent dispatches promptly
      expect(dispatchTick).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('mark_merged requires data.target', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({ action: 'mark_merged', data: { issueId: ISSUE_ID } }),
      ).rejects.toThrow(/BAD_REQUEST/);
    });

    it('mark_merged requires data.issueId', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({ action: 'mark_merged', data: { target: 'base' } }),
      ).rejects.toThrow(/BAD_REQUEST/);
    });

    it('unmark clears merged_at to NULL, writes audit comment, broadcasts, and does NOT tick', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssue (merged_at currently set)
      selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, mergedAt: STAMPED }]);
      // membership
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
      // audit comment insert
      insertReturning.mockResolvedValueOnce([{ ...auditCommentRow, body: 'unmark' }]);
      // re-load fresh (cleared)
      selectLimit.mockResolvedValueOnce([{ ...baseIssueRow, mergedAt: null }]);

      const { hooks } = await import('../../pipeline/hooks.js');

      const result = (await tool.handler({
        action: 'unmark',
        data: { issueId: ISSUE_ID, note: 'epic rolled back' },
      })) as { mergedAt: Date | null; status: string };

      expect(result.status).toBe('unmarked');
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
      // clearing only adds a block — no dispatcher wake.
      expect(dispatchTick).not.toHaveBeenCalled();
    });

    it('unmark requires data.issueId', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      await expect(tool.handler({ action: 'unmark', data: {} })).rejects.toThrow(/BAD_REQUEST/);
    });

    it('mark_merged rejects a non-member device with FORBIDDEN', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssue
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      // project owned by someone else
      selectLimit.mockResolvedValueOnce([{ ownerId: 'someone-else' }]);
      // no member row
      selectLimit.mockResolvedValueOnce([]);

      await expect(
        tool.handler({ action: 'mark_merged', data: { issueId: ISSUE_ID, target: 'base' } }),
      ).rejects.toThrow(/FORBIDDEN/);
    });

    it("unmark rejects with NOT_FOUND when the issue's project is outside the PAT allowlist", async () => {
      const tool = forgeIssuesTool({
        principal: {
          kind: 'pat',
          userId: OWNER_ID,
          tokenId: '55555555-5555-4555-8555-555555555555',
          scopes: ['read', 'write'],
          projectIds: ['66666666-6666-4666-8666-666666666666'],
        },
        device: fakeDevice,
        projectSlug: null,
      });
      // loadIssue resolves a row whose project is NOT in the allowlist
      selectLimit.mockResolvedValueOnce([baseIssueRow]);
      await expect(tool.handler({ action: 'unmark', data: { issueId: ISSUE_ID } })).rejects.toThrow(
        /NOT_FOUND/,
      );
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
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssueProjectId
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      // assertPrincipalIsMember → project owner row
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
      // insert returns task row
      insertReturning.mockResolvedValueOnce([baseTaskRow]);

      const result = (await tool.handler({
        action: 'createTask',
        data: { issueId: ISSUE_ID, taskTitle: 'Sub-task' },
      })) as { task: { documentId: string; title: string; status: string } };

      expect(result.task.documentId).toBe(TASK_ID);
      expect(result.task.title).toBe('Sub-task');
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: ISSUE_ID,
          projectId: PROJECT_ID,
          title: 'Sub-task',
          status: 'backlog',
          priority: 'none',
          isAgentTask: false,
        }),
      );
    });

    it('createTask: requires data.issueId', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({ action: 'createTask', data: { taskTitle: 'x' } }),
      ).rejects.toThrow(/BAD_REQUEST/);
    });

    it('createTask: requires data.taskTitle', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      await expect(
        tool.handler({ action: 'createTask', data: { issueId: ISSUE_ID } }),
      ).rejects.toThrow(/BAD_REQUEST/);
    });

    it('listTasks: returns serialized rows filtered by parent issue', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      // loadIssueProjectId
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      // membership
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
      // list query
      selectLimit.mockResolvedValueOnce([baseTaskRow]);

      const result = (await tool.handler({
        action: 'listTasks',
        filters: { issue: ISSUE_ID },
      })) as { tasks: Array<{ documentId: string }> };

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.documentId).toBe(TASK_ID);
    });

    it('listTasks: respects filters.taskStatus', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([{ projectId: PROJECT_ID }]);
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
      selectLimit.mockResolvedValueOnce([{ ...baseTaskRow, status: 'in_progress' }]);

      const result = (await tool.handler({
        action: 'listTasks',
        filters: { issue: ISSUE_ID, taskStatus: 'in_progress' },
      })) as { tasks: Array<{ status: string }> };
      expect(result.tasks[0]?.status).toBe('in_progress');
    });

    it('listTasks: requires filters.issue', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      await expect(tool.handler({ action: 'listTasks' })).rejects.toThrow(/BAD_REQUEST/);
    });

    it('updateTask: patches mapped fields', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      // loadTaskForAccess
      selectLimit.mockResolvedValueOnce([baseTaskRow]);
      // membership
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);
      // update returns row
      updateReturning.mockResolvedValueOnce([{ ...baseTaskRow, status: 'done' }]);

      const result = (await tool.handler({
        action: 'updateTask',
        documentId: TASK_ID,
        data: { taskStatus: 'done' },
      })) as { task: { status: string } };

      expect(result.task.status).toBe('done');
      expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
    });

    it('deleteTask: runs db.delete after membership check', async () => {
      const tool = forgeIssuesTool({
        principal: { kind: 'device', device: fakeDevice },
        device: fakeDevice,
        projectSlug: PROJECT_SLUG,
      });
      selectLimit.mockResolvedValueOnce([baseTaskRow]);
      selectLimit.mockResolvedValueOnce([{ ownerId: OWNER_ID }]);

      const result = (await tool.handler({
        action: 'deleteTask',
        documentId: TASK_ID,
      })) as { deleted: boolean; documentId: string };

      expect(result.deleted).toBe(true);
      expect(result.documentId).toBe(TASK_ID);
      expect(deleteWhere).toHaveBeenCalled();
    });
  });
});
