import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));

const queue: unknown[] = [];

// biome-ignore lint/suspicious/noExplicitAny: chainable mock proxy
const chain: any = {};
chain.from = () => chain;
chain.leftJoin = () => chain;
chain.where = () => chain;
chain.orderBy = () => chain;
chain.limit = () => chain;
// biome-ignore lint/suspicious/noExplicitAny: thenable bridge
// biome-ignore lint/suspicious/noThenProperty: drizzle chains resolve via await — the mock must be thenable
chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift()).then(resolve, reject);

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => chain) },
}));

const loadIssue = vi.fn();
vi.mock('./forge-issues.js', () => ({
  loadIssue: (...args: unknown[]) => loadIssue(...args),
  // identity serializer — bundle assertions read the raw row. The
  // attachment-aware variant just adds an empty `attachments[]` here (the
  // real DB join is exercised in forge-issues.test.ts).
  serialize: (row: unknown) => row,
  serializeWithAttachments: async (row: Record<string, unknown>) => ({
    ...row,
    attachments: [],
  }),
}));

// Comment attachments are joined separately in the handler; stub to empty so
// the bundle shape is exercised without programming another db chain.
vi.mock('../../comments/attachment-service.js', () => ({
  listCommentAttachmentsForIssue: vi.fn(async () => new Map()),
}));

const applyStatusTransition = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../issues/apply-transition.js', () => ({
  applyStatusTransition: (...args: unknown[]) => applyStatusTransition(...args),
}));

const getIssueContexts = vi.fn(async (..._args: unknown[]) => [
  { step: 'plan', payload: { planSummary: 'x' } },
]);
vi.mock('../../pipeline/issue-context-store.js', () => ({
  getIssueContexts: (...args: unknown[]) => getIssueContexts(...args),
}));

const { forgeStepStartTool } = await import('./forge-step-start.js');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
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

const ctx = {
  principal: { kind: 'device' as const, device: fakeDevice },
  device: fakeDevice,
  projectSlug: null,
};

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    projectId: PROJECT_ID,
    status: 'approved',
    reopenCount: 0,
    sessionContext: null,
    ...overrides,
  };
}

/** Queue: membership assert → (handler) comments rows → projects row. */
function queueHappyPath(opts?: { comments?: unknown[]; project?: unknown }) {
  queue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }], opts?.comments ?? [], [
    opts?.project ?? { baseBranch: 'main', productionBranch: 'main' },
  ]);
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('forge_step_start', () => {
  it('flips trigger → working for code (approved → in_progress) and returns the bundle', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue());
    queueHappyPath({ comments: [{ documentId: 'c1', body: 'triage note' }] });

    const result = (await tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })) as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: test readback
      any
    >;

    expect(applyStatusTransition).toHaveBeenCalledTimes(1);
    expect(applyStatusTransition).toHaveBeenCalledWith(
      expect.objectContaining({ id: ISSUE_ID }),
      'in_progress',
      fakeDevice,
    );
    expect(result.stage).toBe('code'); // derived from trigger status, no input needed
    expect(result.statusChanged).toBe(true);
    expect(result.issue.status).toBe('in_progress');
    expect(result.comments).toHaveLength(1);
    expect(result.handoffs).toHaveLength(1);
  });

  it('bundle carries attachments[] on the issue and on each comment', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue());
    queueHappyPath({ comments: [{ documentId: 'c1', body: 'has a screenshot' }] });

    const result = (await tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })) as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: test readback
      any
    >;

    expect(result.issue.attachments).toEqual([]);
    expect(result.comments[0].attachments).toEqual([]);
  });

  it('is idempotent on resume — already at working status, no transition', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue({ status: 'in_progress' }));
    queueHappyPath();

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      stage: 'code',
    })) as { statusChanged: boolean; statusNote?: string };

    expect(applyStatusTransition).not.toHaveBeenCalled();
    expect(result.statusChanged).toBe(false);
    expect(result.statusNote).toMatch(/already at 'in_progress'/);
  });

  it('fix re-entry flips reopen → in_progress', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue({ status: 'reopen' }));
    queueHappyPath();

    const result = (await tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })) as {
      stage: string;
      statusChanged: boolean;
    };
    expect(result.stage).toBe('fix');
    expect(result.statusChanged).toBe(true);
    expect(applyStatusTransition).toHaveBeenCalledWith(
      expect.anything(),
      'in_progress',
      fakeDevice,
    );
  });

  it('steps without a working status check in without touching status', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue({ status: 'open' }));
    queueHappyPath();

    const result = (await tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })) as {
      stage: string;
      statusChanged: boolean;
      statusNote?: string;
    };
    expect(result.stage).toBe('triage');
    expect(result.statusChanged).toBe(false);
    expect(result.statusNote).toMatch(/no in-flight status/);
    expect(applyStatusTransition).not.toHaveBeenCalled();
  });

  it('never stomps an issue that is not at the trigger status', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue({ status: 'needs_info' }));
    queueHappyPath();

    const result = (await tool.handler({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      stage: 'code',
    })) as { statusChanged: boolean; statusNote?: string };

    expect(applyStatusTransition).not.toHaveBeenCalled();
    expect(result.statusChanged).toBe(false);
    expect(result.statusNote).toMatch(/not flipped/);
  });

  it('requires explicit stage when the status alone is ambiguous', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue({ status: 'in_progress' }));
    queue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);

    await expect(tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })).rejects.toThrow(
      /BAD_REQUEST.*pass `stage`/,
    );
  });

  it('rejects an issue outside the project', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue({ projectId: 'other-project' }));
    queue.push([{ orgId: 'org-1', memberRole: 'member', orgRole: null }]);

    await expect(tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })).rejects.toThrow(
      /NOT_FOUND/,
    );
  });

  it('layers the issue branchConfig override over project defaults', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(
      makeIssue({
        status: 'open',
        sessionContext: { branchConfig: { baseBranch: 'iss-99-integration' } },
      }),
    );
    queueHappyPath({ project: { baseBranch: 'develop', productionBranch: 'main' } });

    const result = (await tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })) as {
      branchConfig: { baseBranch: string | null; targetBranch: string | null };
    };
    expect(result.branchConfig.baseBranch).toBe('iss-99-integration');
    expect(result.branchConfig.targetBranch).toBe('iss-99-integration');
  });

  it('caps a fat comment thread: keeps most-recent, trims oldest, bounds JSON, preserves invariants', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue({ status: 'open' }));
    // 60 fat comments (~9K body each), oldest→newest as the handler returns them.
    const fatComments = Array.from({ length: 60 }, (_, i) => ({
      documentId: `c${i}`,
      body: `comment ${i} `.padEnd(9000, 'x'),
    }));
    queueHappyPath({ comments: fatComments });

    const result = (await tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })) as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: test readback
      any
    >;

    expect(result.commentsTruncated).toBe(true);
    expect(result.commentsTotal).toBe(60);
    expect(result.commentsReturned).toBe(result.comments.length);
    expect(result.commentsReturned).toBeLessThan(60);
    expect(result.commentsNotice).toMatch(/forge_comments\.list/);

    // recent kept, oldest dropped
    const ids = result.comments.map((c: { documentId: string }) => c.documentId);
    expect(ids).toContain('c59');
    expect(ids).not.toContain('c0');

    // bounds: char budget on the comments array
    expect(JSON.stringify(result.comments).length).toBeLessThanOrEqual(30_000);

    // invariants never trimmed
    expect(result.issue.id).toBe(ISSUE_ID);
    expect(result.handoffs).toHaveLength(1);
    expect(result.branchConfig).toBeTruthy();
  });

  it('does not truncate a small comment thread', async () => {
    const tool = forgeStepStartTool(ctx);
    loadIssue.mockResolvedValue(makeIssue({ status: 'open' }));
    const small = Array.from({ length: 5 }, (_, i) => ({ documentId: `c${i}`, body: `note ${i}` }));
    queueHappyPath({ comments: small });

    const result = (await tool.handler({ projectId: PROJECT_ID, issueId: ISSUE_ID })) as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: test readback
      any
    >;

    expect(result.comments).toHaveLength(5);
    expect(result.commentsTruncated).toBeUndefined();
    expect(result.commentsReturned).toBeUndefined();
    expect(result.commentsNotice).toBeUndefined();
  });
});
