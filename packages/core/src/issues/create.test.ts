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
const transaction = vi.fn(async (fn: (tx: { insert: typeof txInsert }) => Promise<unknown>) =>
  fn({ insert: txInsert }),
);

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
