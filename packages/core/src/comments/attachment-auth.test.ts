import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ISS-706 regression coverage. Before the fix, `index.ts` mounted two Hono
// sub-apps at the same `/api/comments` prefix: `commentRoutes` (strict
// JWT-only `use('*')`) mounted FIRST, then `commentUploadRoutes` (permissive
// `requireAnyAuth` `use('*')`) mounted SECOND. Hono flattens both routers'
// wildcard middleware into one linear chain at that prefix, so the strict
// wildcard ran (and 401'd) ahead of the permissive one for every
// `/api/comments/*` request, including the attachment routes only the second
// router implemented. The fix merges both into one `commentRoutes` router
// with per-route auth (no router-wide wildcard at all) — this test builds
// the app the same way `index.ts` does post-fix and would have failed on the
// pre-fix code (a test that mounts `commentUploadRoutes` in isolation, as the
// old `upload.test.ts` did, can't see the cross-router collision).

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

// Generic chainable query-builder mock: every method returns the same object
// so any call sequence (`.from().innerJoin().innerJoin().where().limit()`,
// `.from().where()`, `.set().where().returning()`, ...) is supported; the
// object is thenable and resolves the next queued result on `await`,
// regardless of which chain shape produced it.
const dbResultQueue: unknown[] = [];
function queueResult(value: unknown) {
  dbResultQueue.push(value);
}
function nextResult(): Promise<unknown> {
  if (dbResultQueue.length === 0) {
    throw new Error('attachment-auth.test.ts: unexpected db call with no queued result');
  }
  return Promise.resolve(dbResultQueue.shift());
}
function chain(): any {
  const c: any = {
    from: () => c,
    innerJoin: () => c,
    where: () => c,
    limit: () => c,
    orderBy: () => c,
    offset: () => c,
    set: () => c,
    returning: () => c,
    values: () => c,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      nextResult().then(resolve, reject),
  };
  return c;
}

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => chain()),
    update: vi.fn(() => chain()),
    delete: vi.fn(() => chain()),
    insert: vi.fn(() => chain()),
  },
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

const storageGet = vi.fn();
vi.mock('../storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../storage/index.js')>('../storage/index.js');
  return {
    ...actual,
    getStorage: () => ({ get: storageGet }),
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

const { commentRoutes } = await import('./routes.js');
const { signUserToken } = await import('../auth/jwt.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

// Mirrors index.ts's post-fix composition: a single commentRoutes mount at
// /api/comments (the second, permissive commentUploadRoutes mount is gone).
function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars & { userId: string };
  }>();
  app.use('*', requestId());
  app.route('/api/comments', commentRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return app;
}

const COMMENT_ID = '11111111-1111-4111-8111-111111111111';
const ISSUE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const ATT_ID = '55555555-5555-4555-8555-555555555555';

const PAT_TOKEN =
  'forge_pat_dev_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DEVICE_TOKEN = 'device_token_opaque_value';

beforeEach(() => {
  vi.clearAllMocks();
  dbResultQueue.length = 0;
  projectAccess.mockReset();
  persistCommentAttachmentMock.mockReset();
  storageGet.mockReset();
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

function memberAccess() {
  return { projectId: PROJECT_ID, orgId: 'org-1', role: 'admin' as const, orgRole: 'owner' as const };
}

describe('GET /api/comments/attachments/:id — auth paths (AC-A)', () => {
  it('200 with bytes via user JWT', async () => {
    queueResult([{ id: ATT_ID, path: '/tmp/x.png', mime: 'image/png', name: 'a.png', projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    storageGet.mockResolvedValueOnce(Buffer.from([1, 2, 3]));

    const res = await buildApp().request(`/api/comments/attachments/${ATT_ID}`, {
      headers: { authorization: `Bearer ${await userJwt()}` },
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('200 with bytes via PAT', async () => {
    verifyPatMock.mockResolvedValueOnce({
      row: { id: 'pat-1', userId: USER_ID, scopes: [], projectIds: null, rateLimitMax: null },
    });
    queueResult([{ id: ATT_ID, path: '/tmp/x.png', mime: 'image/png', name: 'a.png', projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    storageGet.mockResolvedValueOnce(Buffer.from([1, 2, 3]));

    const res = await buildApp().request(`/api/comments/attachments/${ATT_ID}`, {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(verifyPatMock).toHaveBeenCalledOnce();
  });

  it('200 with bytes via device token', async () => {
    verifyDeviceTokenMock.mockResolvedValueOnce({ id: 'device-1', ownerId: USER_ID });
    queueResult([{ id: ATT_ID, path: '/tmp/x.png', mime: 'image/png', name: 'a.png', projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    storageGet.mockResolvedValueOnce(Buffer.from([1, 2, 3]));

    const res = await buildApp().request(`/api/comments/attachments/${ATT_ID}`, {
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(verifyDeviceTokenMock).toHaveBeenCalledOnce();
  });
});

describe('GET /api/comments/attachments/:id — inert serving for svg/html (AC-B)', () => {
  it('image/svg+xml downloads as attachment with CSP sandbox + nosniff', async () => {
    queueResult([
      { id: ATT_ID, path: '/tmp/x.svg', mime: 'image/svg+xml', name: 'mock.svg', projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    storageGet.mockResolvedValueOnce(Buffer.from('<svg><script>alert(1)</script></svg>'));

    const res = await buildApp().request(`/api/comments/attachments/${ATT_ID}`, {
      headers: { authorization: `Bearer ${await userJwt()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('text/html downloads as attachment with CSP sandbox + nosniff', async () => {
    queueResult([
      { id: ATT_ID, path: '/tmp/x.html', mime: 'text/html', name: 'mock.html', projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    storageGet.mockResolvedValueOnce(Buffer.from('<script>alert(1)</script>'));

    const res = await buildApp().request(`/api/comments/attachments/${ATT_ID}`, {
      headers: { authorization: `Bearer ${await userJwt()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('image/png (unaffected mime) still serves inline, no CSP', async () => {
    queueResult([
      { id: ATT_ID, path: '/tmp/x.png', mime: 'image/png', name: 'a.png', projectId: PROJECT_ID },
    ]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    storageGet.mockResolvedValueOnce(Buffer.from([1, 2, 3]));

    const res = await buildApp().request(`/api/comments/attachments/${ATT_ID}`, {
      headers: { authorization: `Bearer ${await userJwt()}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('inline');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('POST /api/comments/:commentId/attachments — auth paths', () => {
  it('401 without token', async () => {
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      body: makeFile('x'),
    });
    expect(res.status).toBe(401);
  });

  it('201 via user JWT', async () => {
    queueResult([{ id: COMMENT_ID, issueId: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce(memberAccess());
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
    queueResult([{ id: COMMENT_ID, issueId: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    persistCommentAttachmentMock.mockResolvedValueOnce({
      id: ATT_ID,
      commentId: COMMENT_ID,
      name: 'pic.png',
      mime: 'image/png',
      size: 5,
    });
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
      body: makeFile('hello'),
    });
    expect(res.status).toBe(201);
    expect(verifyPatMock).toHaveBeenCalledOnce();
  });

  it('201 via device token', async () => {
    verifyDeviceTokenMock.mockResolvedValueOnce({ id: 'device-1', ownerId: USER_ID });
    queueResult([{ id: COMMENT_ID, issueId: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    persistCommentAttachmentMock.mockResolvedValueOnce({
      id: ATT_ID,
      commentId: COMMENT_ID,
      name: 'pic.png',
      mime: 'image/png',
      size: 5,
    });
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
      body: makeFile('hello'),
    });
    expect(res.status).toBe(201);
    expect(verifyDeviceTokenMock).toHaveBeenCalledOnce();
  });

  it('404 when comment missing', async () => {
    queueResult([]);
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await userJwt()}` },
      body: makeFile('x'),
    });
    expect(res.status).toBe(404);
  });

  it('403 when not a project member', async () => {
    queueResult([{ id: COMMENT_ID, issueId: ISSUE_ID, projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce({ projectId: PROJECT_ID, orgId: 'org-1', role: null, orgRole: null });
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await userJwt()}` },
      body: makeFile('x'),
    });
    expect(res.status).toBe(403);
  });
});

describe('Comment CRUD auth is NOT widened by the merge (AC-A bullet 2)', () => {
  it('GET /:id/replies 401s a device token', async () => {
    verifyDeviceTokenMock.mockResolvedValueOnce(null);
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/replies`, {
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('GET /:id/replies 401s a PAT', async () => {
    verifyPatMock.mockResolvedValueOnce(null);
    verifyDeviceTokenMock.mockResolvedValueOnce(null);
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/replies`, {
      headers: { authorization: `Bearer ${PAT_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('PATCH /:id 401s a device token', async () => {
    verifyDeviceTokenMock.mockResolvedValueOnce(null);
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'edited' }),
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /:id 401s a device token', async () => {
    verifyDeviceTokenMock.mockResolvedValueOnce(null);
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('GET /:id/replies 200s a valid user JWT (auth still works for the real case)', async () => {
    // assertEmailVerified() runs first on this route and does its own db lookup.
    queueResult([{ emailVerifiedAt: new Date('2026-01-01') }]);
    queueResult([{ id: COMMENT_ID, issueId: ISSUE_ID, authorId: USER_ID, body: 'x', projectId: PROJECT_ID }]);
    projectAccess.mockResolvedValueOnce(memberAccess());
    queueResult([{ n: 0 }]);
    queueResult([]);
    const res = await buildApp().request(`/api/comments/${COMMENT_ID}/replies`, {
      headers: { authorization: `Bearer ${await userJwt()}` },
    });
    expect(res.status).toBe(200);
  });
});
