import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
const TEST_PEPPER = 'test-pepper-32-chars-long-abcdefghij';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: TEST_SECRET,
    DEVICE_TOKEN_PEPPER: TEST_PEPPER,
    NODE_ENV: 'test',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
    UPLOADS_DIR: './uploads',
    STORAGE_DRIVER: 'local',
  },
}));

const selectInnerJoinLimit = vi.fn();
const selectInnerJoinWhere = vi.fn(() => ({ limit: selectInnerJoinLimit }));
const selectInnerJoin = vi.fn(() => ({ where: selectInnerJoinWhere }));
const selectFrom = vi.fn(() => ({ innerJoin: selectInnerJoin }));

vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const projectAccess = vi.fn();
vi.mock('../lib/authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz.js')>()),
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const persistCommentAttachmentMock = vi.fn();
vi.mock('./attachment-service.js', async () => {
  const actual =
    await vi.importActual<typeof import('./attachment-service.js')>('./attachment-service.js');
  return {
    ...actual,
    persistCommentAttachment: (...args: unknown[]) => persistCommentAttachmentMock(...args),
  };
});

const verifyPatMock = vi.fn();
const verifyDeviceTokenMock = vi.fn();
vi.mock('../auth/pat.js', async () => {
  const actual = await vi.importActual<typeof import('../auth/pat.js')>('../auth/pat.js');
  return { ...actual, verifyPat: (...args: unknown[]) => verifyPatMock(...args) };
});
vi.mock('../auth/deviceToken.js', async () => {
  const actual =
    await vi.importActual<typeof import('../auth/deviceToken.js')>('../auth/deviceToken.js');
  return { ...actual, verifyDeviceToken: (...args: unknown[]) => verifyDeviceTokenMock(...args) };
});

const { commentUploadRoutes } = await import('./upload.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars & { userId: string };
  }>();
  app.use('*', requestId());
  app.route('/api/comments', commentUploadRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

const COMMENT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const ATT_ID = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  selectInnerJoinLimit.mockReset();
  projectAccess.mockReset();
  persistCommentAttachmentMock.mockReset();
  verifyPatMock.mockReset();
  verifyDeviceTokenMock.mockReset();
});

async function userJwt() {
  return signUserToken(USER_ID);
}

function makeFile(content: string, name = 'pic.png', type = 'image/png'): FormData {
  const fd = new FormData();
  fd.append('file', new File([content], name, { type }));
  return fd;
}

describe('POST /api/comments/:commentId/attachments — auth paths', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      body: makeFile('x'),
    });
    expect(res.status).toBe(401);
  });

  it('201 via user JWT', async () => {
    selectInnerJoinLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'owner',
    });
    persistCommentAttachmentMock.mockResolvedValueOnce({
      id: ATT_ID,
      commentId: COMMENT_ID,
      name: 'pic.png',
      mime: 'image/png',
      size: 5,
    });
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await userJwt()}` },
      body: makeFile('hello'),
    });
    expect(res.status).toBe(201);
  });

  it('201 via PAT', async () => {
    verifyPatMock.mockResolvedValueOnce({
      row: { id: 'pat-1', userId: USER_ID, scopes: [], projectIds: null, rateLimitMax: null },
    });
    selectInnerJoinLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'owner',
    });
    persistCommentAttachmentMock.mockResolvedValueOnce({
      id: ATT_ID,
      commentId: COMMENT_ID,
      name: 'pic.png',
      mime: 'image/png',
      size: 5,
    });
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: {
        authorization:
          'Bearer forge_pat_dev_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      body: makeFile('hello'),
    });
    expect(res.status).toBe(201);
    expect(verifyPatMock).toHaveBeenCalledOnce();
  });

  it('201 via device token', async () => {
    verifyDeviceTokenMock.mockResolvedValueOnce({ id: 'device-1', ownerId: USER_ID });
    selectInnerJoinLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      orgId: 'org-1',
      role: 'admin',
      orgRole: 'owner',
    });
    persistCommentAttachmentMock.mockResolvedValueOnce({
      id: ATT_ID,
      commentId: COMMENT_ID,
      name: 'pic.png',
      mime: 'image/png',
      size: 5,
    });
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: 'Bearer device_token_opaque_value' },
      body: makeFile('hello'),
    });
    expect(res.status).toBe(201);
    expect(verifyDeviceTokenMock).toHaveBeenCalledOnce();
  });

  it('404 when comment missing', async () => {
    selectInnerJoinLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await userJwt()}` },
      body: makeFile('x'),
    });
    expect(res.status).toBe(404);
  });

  it('403 when not a project member', async () => {
    selectInnerJoinLimit.mockResolvedValueOnce([
      { id: COMMENT_ID, issueId: ISSUE_ID, projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null });
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await userJwt()}` },
      body: makeFile('x'),
    });
    expect(res.status).toBe(403);
  });
});
