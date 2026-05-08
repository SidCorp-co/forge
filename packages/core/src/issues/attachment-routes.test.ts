import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: TEST_SECRET,
    NODE_ENV: 'test',
    UPLOADS_MAX_BYTES: 10 * 1024 * 1024,
    UPLOADS_DIR: './uploads',
    STORAGE_DRIVER: 'local',
  },
}));

const selectLimit = vi.fn();
const selectInnerJoinLimit = vi.fn();
const selectInnerJoinWhere = vi.fn(() => ({ limit: selectInnerJoinLimit }));
const selectInnerJoin = vi.fn(() => ({ where: selectInnerJoinWhere }));
const selectOrderBy = vi.fn();
const selectListWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({
  where: (...args: unknown[]) => {
    // first call (issue lookup) uses .where().limit(); list call uses .where().orderBy()
    return { limit: selectLimit, orderBy: selectOrderBy, ...selectWhere(...args), ...selectListWhere(...args) };
  },
  innerJoin: selectInnerJoin,
}));
const insertReturning = vi.fn();
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const deleteWhere = vi.fn(async () => undefined);
const deleteFrom = vi.fn(() => ({ where: deleteWhere }));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    insert: vi.fn(() => ({ values: insertValues })),
    delete: vi.fn(() => deleteFrom()),
  },
}));

const projectAccess = vi.fn();
vi.mock('../lib/project-access.js', () => ({
  loadProjectAccess: (...args: unknown[]) => projectAccess(...args),
}));

const storagePut = vi.fn();
const storageGet = vi.fn();
const storageDelete = vi.fn();
vi.mock('../storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../storage/index.js')>('../storage/index.js');
  return {
    ...actual,
    getStorage: () => ({ put: storagePut, get: storageGet, delete: storageDelete }),
  };
});

const safeRecordActivityMock = vi.fn(async () => undefined);
vi.mock('../pipeline/activity.js', () => ({
  safeRecordActivity: (...args: unknown[]) => safeRecordActivityMock(...args),
}));

const { registerIssueAttachmentRoutes, attachmentRoutes } = await import('./attachment-routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');
const { requireAuth, assertEmailVerified } = await import('../middleware/auth.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars &
      import('../middleware/auth.js').AuthVars;
  }>();
  app.use('*', requestId());
  const issueRoutes = new Hono<{ Variables: import('../middleware/auth.js').AuthVars }>();
  issueRoutes.use('*', requireAuth(), assertEmailVerified());
  registerIssueAttachmentRoutes(issueRoutes);
  app.route('/api/issues', issueRoutes);
  app.route('/api/attachments', attachmentRoutes);
  app.onError(errorHandler);
  return app;
}

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ATT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectInnerJoinLimit.mockReset();
  selectOrderBy.mockReset();
  projectAccess.mockReset();
  insertReturning.mockReset();
  storagePut.mockReset();
  storageGet.mockReset();
  storageDelete.mockReset();
  safeRecordActivityMock.mockClear();
});

function authVerified() {
  selectLimit.mockResolvedValueOnce([{ emailVerifiedAt: new Date() }]);
}

async function token() {
  return signUserToken(USER_ID);
}

function makeFile(content: string, name = 'pic.png', type = 'image/png'): FormData {
  const fd = new FormData();
  fd.append('file', new File([content], name, { type }));
  return fd;
}

describe('POST /api/issues/:id/attachments', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/attachments`, {
      method: 'POST',
      body: makeFile('x'),
    });
    expect(res.status).toBe(401);
  });

  it('404 when issue missing', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([]);
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: makeFile('x'),
    });
    expect(res.status).toBe(404);
  });

  it('403 when not a project member', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, ownerId: OTHER_USER, role: null });
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: makeFile('x'),
    });
    expect(res.status).toBe(403);
  });

  it('400 on disallowed mime', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    const fd = new FormData();
    fd.append('file', new File(['x'], 'evil.exe', { type: 'application/x-msdownload' }));
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: fd,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code?: string };
    expect(json.code).toBe('MIME_NOT_ALLOWED');
  });

  it('400 on empty file', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    const fd = new FormData();
    fd.append('file', new File([''], 'pic.png', { type: 'image/png' }));
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it('201 on happy path: stores file, inserts row, fires activity', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    storagePut.mockResolvedValueOnce({ path: '/tmp/issues/x/y.png' });
    insertReturning.mockResolvedValueOnce([
      {
        id: ATT_ID,
        issueId: ISSUE_ID,
        uploaderId: USER_ID,
        name: 'pic.png',
        mime: 'image/png',
        size: 5,
        createdAt: new Date('2026-01-01'),
      },
    ]);

    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: makeFile('hello'),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; url: string };
    expect(json.id).toBe(ATT_ID);
    expect(json.url).toBe(`/api/attachments/${ATT_ID}/download`);
    expect(storagePut).toHaveBeenCalledOnce();
    expect(safeRecordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue.attachment.uploaded' }),
    );
  });
});

describe('GET /api/issues/:id/attachments', () => {
  it('returns rows for the issue', async () => {
    authVerified();
    selectLimit.mockResolvedValueOnce([{ id: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    selectOrderBy.mockResolvedValueOnce([
      {
        id: ATT_ID,
        issueId: ISSUE_ID,
        uploaderId: USER_ID,
        name: 'a.png',
        mime: 'image/png',
        size: 100,
        createdAt: new Date('2026-01-01'),
      },
    ]);
    const res = await buildApp().request(`/api/issues/${ISSUE_ID}/attachments`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ id: string; url: string }>;
    expect(json).toHaveLength(1);
    expect(json[0].url).toBe(`/api/attachments/${ATT_ID}/download`);
  });
});

describe('GET /api/attachments/:id/download', () => {
  it('streams bytes with content-type and disposition', async () => {
    authVerified();
    selectInnerJoinLimit.mockResolvedValueOnce([
      {
        id: ATT_ID,
        path: '/tmp/x.png',
        mime: 'image/png',
        name: 'a.png',
        projectId: PROJECT_ID,
      },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    storageGet.mockResolvedValueOnce(Buffer.from([1, 2, 3]));
    const res = await buildApp().request(`/api/attachments/${ATT_ID}/download`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain('a.png');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([1, 2, 3]);
  });

  it('410 when storage file is missing', async () => {
    authVerified();
    selectInnerJoinLimit.mockResolvedValueOnce([
      {
        id: ATT_ID,
        path: '/tmp/x.png',
        mime: 'image/png',
        name: 'a.png',
        projectId: PROJECT_ID,
      },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    storageGet.mockRejectedValueOnce(Object.assign(new Error('enoent'), { code: 'ENOENT' }));
    const res = await buildApp().request(`/api/attachments/${ATT_ID}/download`, {
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(410);
  });
});

describe('DELETE /api/attachments/:id', () => {
  it('204 by uploader; deletes storage + row; logs activity', async () => {
    authVerified();
    selectInnerJoinLimit.mockResolvedValueOnce([
      {
        id: ATT_ID,
        issueId: ISSUE_ID,
        uploaderId: USER_ID,
        name: 'a.png',
        path: '/tmp/x.png',
        projectId: PROJECT_ID,
      },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: OTHER_USER,
      role: 'member',
    });
    storageDelete.mockResolvedValueOnce(undefined);
    const res = await buildApp().request(`/api/attachments/${ATT_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
    expect(storageDelete).toHaveBeenCalledWith('/tmp/x.png');
    expect(deleteWhere).toHaveBeenCalled();
    expect(safeRecordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue.attachment.deleted' }),
    );
  });

  it('204 by project owner who is not the uploader', async () => {
    authVerified();
    selectInnerJoinLimit.mockResolvedValueOnce([
      {
        id: ATT_ID,
        issueId: ISSUE_ID,
        uploaderId: OTHER_USER,
        name: 'a.png',
        path: '/tmp/x.png',
        projectId: PROJECT_ID,
      },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: USER_ID,
      role: 'owner',
    });
    storageDelete.mockResolvedValueOnce(undefined);
    const res = await buildApp().request(`/api/attachments/${ATT_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(204);
  });

  it('403 when caller is a member but neither uploader nor owner', async () => {
    authVerified();
    selectInnerJoinLimit.mockResolvedValueOnce([
      {
        id: ATT_ID,
        issueId: ISSUE_ID,
        uploaderId: OTHER_USER,
        name: 'a.png',
        path: '/tmp/x.png',
        projectId: PROJECT_ID,
      },
    ]);
    projectAccess.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      ownerId: OTHER_USER,
      role: 'member',
    });
    const res = await buildApp().request(`/api/attachments/${ATT_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.status).toBe(403);
    expect(storageDelete).not.toHaveBeenCalled();
  });
});
