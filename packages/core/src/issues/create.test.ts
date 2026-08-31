// ISS-454 quick capture persists the operator's context as `description`.
// The ai* intake fields it originally also wrote were dropped once measurement
// showed no pipeline stage ever read them, so the create surface must now
// REJECT them — `issueCreateSchema` is `.strict()`, which is what enforces the
// AC-is-decided-when-an-issue-runs rule structurally rather than by prompt.

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const txInsert = vi.fn(() => ({ values: insertValues }));
// cm:guard `transaction` records when the tx OPENS; `txCommit` is the only witness of when it closes. An ordering assertion against `transaction` alone cannot fail — the tx opens first in both the fixed and the broken arrangement — so the edge-inside-the-transaction rule needs this second marker to mean anything.
const txCommit = vi.fn();
const transaction = vi.fn(async (fn: (tx: { insert: typeof txInsert }) => Promise<unknown>) => {
  const result = await fn({ insert: txInsert });
  txCommit();
  return result;
});

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })), transaction },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const hooksEmit = vi.fn();
vi.mock('../pipeline/hooks.js', () => ({
  hooks: { emit: (...args: unknown[]) => hooksEmit(...args) },
}));

vi.mock('../comments/routes.js', () => ({
  registerIssueCommentRoutes: () => {},
}));

const applyRelations = vi.fn(async () => [
  {
    applied: {
      edgeId: 'edge-1',
      kind: 'blocks' as const,
      fromIssueId: BLOCKER_ID,
      toIssueId: ISSUE_ID,
      created: true,
      updated: false,
    },
    input: { projectId: PROJECT_ID, fromIssueId: BLOCKER_ID, toIssueId: ISSUE_ID, kind: 'blocks' },
    written: { id: 'edge-1', created: true, updated: false, effect: 'added' },
  },
]);
const flushRelations = vi.fn(async () => undefined);
// cm:guard keep `issueRelationInputSchema` REAL here — it is the create route's own request schema, so stubbing it would make every assertion below pass against a shape the route never validates
vi.mock('./relations-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./relations-service.js')>()),
  writeIssueRelations: (...args: unknown[]) => applyRelations(...(args as [])),
  flushIssueRelationEffects: (...args: unknown[]) => flushRelations(...(args as [])),
}));

const { issueProjectRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', issueProjectRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const BLOCKER_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  // Base default AFTER reset: unscripted selects resolve to no rows. The
  // create route now runs the intake gate (`resolveIntakeGate` selects the
  // project's agentConfig); an empty row = gate disabled = legacy behavior.
  // Per-test `mockResolvedValueOnce` scripts still take precedence in order.
  selectLimit.mockResolvedValue([]);
  insertReturning.mockReset();
  projectAccess.mockReset();
  applyRelations.mockClear();
  flushRelations.mockClear();
  txCommit.mockClear();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

function memberAccess() {
  projectAccess.mockResolvedValueOnce({
    projectId: PROJECT_ID,
    orgId: 'org-1',
    role: 'member',
    orgRole: 'member',
  });
}

async function token() {
  return signUserToken(USER_ID);
}

function insertedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    projectId: PROJECT_ID,
    issSeq: 9,
    title: 'quick capture',
    description: null,
    status: 'open',
    priority: 'medium',
    category: null,
    reportedBy: null,
    complexity: null,
    assigneeId: null,
    createdById: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function postIssue(body: Record<string, unknown>) {
  return buildApp().request(`/api/projects/${PROJECT_ID}/issues`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/projects/:id/issues — quick-capture intake', () => {
  it('persists the operator context as description and echoes it back', async () => {
    authVerified();
    memberAccess();
    insertReturning.mockResolvedValueOnce([insertedRow({ description: 'user wants SSO' })]);

    const res = await postIssue({ title: 'quick capture', description: 'user wants SSO' });
    expect(res.status).toBe(201);

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'quick capture',
        status: 'open',
        description: 'user wants SSO',
      }),
    );

    const body = (await res.json()) as { displayId: string; status: string; description: string };
    expect(body.displayId).toBe('ISS-9');
    expect(body.status).toBe('open');
    expect(body.description).toBe('user wants SSO');
  });

  it('creates with no body fields beyond the title', async () => {
    authVerified();
    memberAccess();
    insertReturning.mockResolvedValueOnce([insertedRow()]);

    const res = await postIssue({ title: 'quick capture' });
    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'quick capture', description: null }),
    );
  });

  for (const field of [
    'aiSummary',
    'aiSuggestedSolution',
    'aiAcceptanceCriteria',
    'suggestedSolution',
    'parentIssueId',
  ]) {
    it(`400 on the dropped ${field} field, with no insert attempted`, async () => {
      authVerified();

      const res = await postIssue({ title: 'quick capture', [field]: 'anything' });
      expect(res.status).toBe(400);
      expect(transaction).not.toHaveBeenCalled();
    });
  }
});

describe('POST /api/projects/:id/issues — relations declared at create (ISS-889)', () => {
  it('commits the declared edge and echoes it back', async () => {
    authVerified();
    memberAccess();
    insertReturning.mockResolvedValueOnce([insertedRow()]);

    const res = await postIssue({
      title: 'quick capture',
      relations: [{ kind: 'blocks', dependsOnId: BLOCKER_ID }],
    });

    expect(res.status).toBe(201);
    expect(applyRelations).toHaveBeenCalledWith(
      expect.objectContaining({ createdById: USER_ID }),
      PROJECT_ID,
      ISSUE_ID,
      [expect.objectContaining({ kind: 'blocks', dependsOnId: BLOCKER_ID })],
      expect.anything(),
    );

    const body = (await res.json()) as { relations?: { edgeId: string }[] };
    expect(body.relations).toEqual([expect.objectContaining({ edgeId: 'edge-1' })]);
  });

  it('commits the edge BEFORE issueCreated, which is what closes the open-then-block race', async () => {
    authVerified();
    memberAccess();
    insertReturning.mockResolvedValueOnce([insertedRow()]);

    await postIssue({
      title: 'quick capture',
      relations: [{ kind: 'blocks', dependsOnId: BLOCKER_ID }],
    });

    // cm:guard the WRITE goes inside the create transaction and the ANNOUNCE comes after it — `transaction` is the only witness that separates the two. Asserting the announce lands before `issueCreated` was already true when the edge itself was written after the commit, which is the crash window ISS-889 closed.
    expect(applyRelations.mock.invocationCallOrder[0]).toBeLessThan(
      txCommit.mock.invocationCallOrder[0] as number,
    );
    expect(flushRelations.mock.invocationCallOrder[0]).toBeGreaterThan(
      applyRelations.mock.invocationCallOrder[0] as number,
    );
    expect(flushRelations.mock.invocationCallOrder[0]).toBeLessThan(
      hooksEmit.mock.invocationCallOrder[0] as number,
    );
  });

  it('400 when a relation names both sides, with no issue written', async () => {
    authVerified();

    const res = await postIssue({
      title: 'quick capture',
      relations: [{ kind: 'blocks', dependsOnId: BLOCKER_ID, blocksId: ISSUE_ID }],
    });

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
    expect(applyRelations).not.toHaveBeenCalled();
  });

  it('400 past the 20-relation ceiling, with no issue written', async () => {
    authVerified();

    const res = await postIssue({
      title: 'quick capture',
      relations: Array.from({ length: 21 }, () => ({ kind: 'blocks', dependsOnId: BLOCKER_ID })),
    });

    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });
});
