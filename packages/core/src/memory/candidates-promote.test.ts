import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));

const updateWhere = vi.fn();
const updateSet = vi.fn(() => ({ where: updateWhere }));

const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const insertInto = vi.fn(() => ({ values: insertValues }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    update: vi.fn(() => ({ set: updateSet })),
    insert: vi.fn(() => insertInto),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  assertProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const createDraftMock = vi.fn();
vi.mock('../improvement-messages/drafts-service.js', () => ({
  createImprovementMessageDraft: (...args: unknown[]) => createDraftMock(...args),
}));

const { memoryCandidatesRoutes } = await import('./candidates-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/memory', memoryCandidatesRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';

const GRADUATED_CANDIDATE = {
  id: CANDIDATE_ID,
  projectId: PROJECT_ID,
  signalType: 'reopen_loop',
  signalKey: 'reopen_loop:bug',
  status: 'graduated',
  confidence: '0.75',
  evidenceCount: 3,
  evidence: [],
  summary: 'Reopen pattern detected for bug issues',
  graduatedAt: new Date(),
  reviewedAt: null,
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_DRAFT = {
  id: '44444444-4444-4444-8444-444444444444',
  key: 'draft-reopen-loop-bug',
  title: 'Reduce recurring reopen patterns',
  message: '⟦UNTRUSTED_DATA⟧...⟦END_UNTRUSTED_DATA⟧',
  rationale: 'Recurring reopen events indicate...',
  appliesWhen: 'The project has recurring reopen events...',
  appliesToSkills: [],
  category: 'pipeline-correctness',
  status: 'pending_review',
  source: 'bottom_up',
  candidateId: CANDIDATE_ID,
  signalKey: 'reopen_loop:bug',
  sourceProjectId: PROJECT_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  updateWhere.mockReset();
  createDraftMock.mockReset();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

describe('POST /api/memory/candidates/:id/promote', () => {
  it('returns 401 without auth', async () => {
    const app = buildApp();
    const res = await app.request(`/api/memory/candidates/${CANDIDATE_ID}/promote`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 when candidate not found', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);

    const app = buildApp();
    const res = await app.request(`/api/memory/candidates/${CANDIDATE_ID}/promote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 when candidate is not graduated', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ ...GRADUATED_CANDIDATE, status: 'accruing' }]);
    projectAccess.mockResolvedValue(undefined);

    const app = buildApp();
    const res = await app.request(`/api/memory/candidates/${CANDIDATE_ID}/promote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(409);
  });

  it('promotes a graduated candidate → creates draft + marks promoted', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([GRADUATED_CANDIDATE]);
    projectAccess.mockResolvedValue(undefined);
    createDraftMock.mockResolvedValue(MOCK_DRAFT);
    updateWhere.mockResolvedValue(undefined);

    const app = buildApp();
    const res = await app.request(`/api/memory/candidates/${CANDIDATE_ID}/promote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { promoted: boolean; draft: { key: string } };
    expect(body.promoted).toBe(true);
    expect(body.draft.key).toBe('draft-reopen-loop-bug');

    expect(createDraftMock).toHaveBeenCalledWith({
      candidateId: CANDIDATE_ID,
      signalKey: 'reopen_loop:bug',
      signalType: 'reopen_loop',
      summary: GRADUATED_CANDIDATE.summary,
      projectId: PROJECT_ID,
    });
    expect(updateWhere).toHaveBeenCalled();
  });

  it('returns 400 for invalid candidate id', async () => {
    authVerified();
    const app = buildApp();
    const res = await app.request('/api/memory/candidates/not-a-uuid/promote', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(400);
  });
});
