// ISS-454 — POST /api/projects/:id/issues accepts + persists the operator-
// entered ai* intake fields (aiSummary / aiSuggestedSolution /
// aiAcceptanceCriteria). Omitting them must preserve the pre-ISS-454
// behaviour (insert null).
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
const transaction = vi.fn(
  async (fn: (tx: { insert: typeof txInsert }) => Promise<unknown>) => fn({ insert: txInsert }),
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
    aiSummary: null,
    aiSuggestedSolution: null,
    aiAcceptanceCriteria: null,
    assigneeId: null,
    createdById: USER_ID,
    parentIssueId: null,
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

describe('POST /api/projects/:id/issues — ai* intake fields (ISS-454)', () => {
  it('persists aiSummary / aiSuggestedSolution / aiAcceptanceCriteria and echoes them back', async () => {
    authVerified();
    memberAccess();
    const criteria = ['login works', 'logout works'];
    insertReturning.mockResolvedValueOnce([
      insertedRow({
        aiSummary: 'user wants SSO',
        aiSuggestedSolution: 'wire OIDC',
        aiAcceptanceCriteria: criteria,
      }),
    ]);

    const res = await postIssue({
      title: 'quick capture',
      description: 'user wants SSO',
      aiSummary: 'user wants SSO',
      aiSuggestedSolution: 'wire OIDC',
      aiAcceptanceCriteria: criteria,
    });
    expect(res.status).toBe(201);

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'quick capture',
        status: 'open',
        aiSummary: 'user wants SSO',
        aiSuggestedSolution: 'wire OIDC',
        aiAcceptanceCriteria: criteria,
      }),
    );

    const body = (await res.json()) as {
      displayId: string;
      status: string;
      aiSummary: string | null;
      aiSuggestedSolution: string | null;
      aiAcceptanceCriteria: string[] | null;
    };
    expect(body.displayId).toBe('ISS-9');
    expect(body.status).toBe('open');
    expect(body.aiSummary).toBe('user wants SSO');
    expect(body.aiSuggestedSolution).toBe('wire OIDC');
    expect(body.aiAcceptanceCriteria).toEqual(criteria);
  });

  it('defaults the ai* fields to null when omitted (pre-ISS-454 behaviour)', async () => {
    authVerified();
    memberAccess();
    insertReturning.mockResolvedValueOnce([insertedRow()]);

    const res = await postIssue({ title: 'quick capture' });
    expect(res.status).toBe(201);

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSummary: null,
        aiSuggestedSolution: null,
        aiAcceptanceCriteria: null,
      }),
    );
  });

  it('accepts explicit nulls for the ai* fields', async () => {
    authVerified();
    memberAccess();
    insertReturning.mockResolvedValueOnce([insertedRow()]);

    const res = await postIssue({
      title: 'quick capture',
      aiSummary: null,
      aiSuggestedSolution: null,
      aiAcceptanceCriteria: null,
    });
    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSummary: null,
        aiSuggestedSolution: null,
        aiAcceptanceCriteria: null,
      }),
    );
  });

  it('400 when aiAcceptanceCriteria is not a string array', async () => {
    authVerified();

    const res = await postIssue({
      title: 'quick capture',
      aiAcceptanceCriteria: 'not-an-array',
    });
    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });
});
