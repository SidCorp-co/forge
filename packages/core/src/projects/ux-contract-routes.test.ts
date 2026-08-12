import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    DEVICE_TOKEN_PEPPER: 'test-pepper',
    KNOWLEDGE_INJECTION_ENABLED: false,
  },
}));

const loggerStub = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock('../logger.js', () => ({
  logger: loggerStub,
  getLogger: () => loggerStub,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth:
    () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER_ID);
      await next();
    },
  assertEmailVerified: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const assertProjectRoleMock = vi.fn();
vi.mock('../lib/authz.js', () => ({
  loadProjectAccess: vi.fn(async () => ({ role: 'admin' })),
  assertProjectRole: (...args: unknown[]) => assertProjectRoleMock(...args),
}));

let projectRow:
  | { id: string; slug: string; repoPath: string | null; agentConfig: unknown }
  | undefined;
const selectLimit = vi.fn(() => Promise.resolve(projectRow ? [projectRow] : []));
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const resolveChatDeviceMock = vi.fn();
const createChatSessionRowMock = vi.fn();
const dispatchChatTurnMock = vi.fn();
const applyKernelTransitionMock = vi.fn();
const closeRunIfOneShotMock = vi.fn();
const signUxScanAuthorizationMock = vi.fn();
vi.mock('./ux-scan-authorization.js', () => ({
  signUxScanAuthorization: (...args: unknown[]) => signUxScanAuthorizationMock(...args),
}));
vi.mock('../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => applyKernelTransitionMock(...args),
}));
vi.mock('../pipeline/runs.js', () => ({
  closeRunIfOneShot: (...args: unknown[]) => closeRunIfOneShotMock(...args),
}));
vi.mock('../agent-sessions/chat-turn.js', () => ({
  resolveChatDevice: (...args: unknown[]) => resolveChatDeviceMock(...args),
  createChatSessionRow: (...args: unknown[]) => createChatSessionRowMock(...args),
  dispatchChatTurn: (...args: unknown[]) => dispatchChatTurnMock(...args),
  noClaudeClient: () =>
    new HTTPException(409, {
      message: 'no client',
      cause: { code: 'NO_CLAUDE_CLIENT' },
    }),
}));

const { uxContractProjectRoutes } = await import('./ux-contract-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{
    Variables: import('../middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/projects', uxContractProjectRoutes);
  app.onError(errorHandler);
  return app;
}

function postScan(body?: Record<string, unknown>) {
  return buildApp().request(`/api/projects/${PROJECT_ID}/ux-contract/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  assertProjectRoleMock.mockReset();
  projectRow = {
    id: PROJECT_ID,
    slug: 'forge-dev',
    repoPath: '/repo',
    agentConfig: {},
  };
  createChatSessionRowMock.mockResolvedValue({
    id: SESSION_ID,
    pipelineRunId: '55555555-5555-4555-8555-555555555555',
    status: 'idle',
  });
  signUxScanAuthorizationMock.mockResolvedValue('signed-authorization');
  dispatchChatTurnMock.mockResolvedValue({ id: SESSION_ID });
  applyKernelTransitionMock.mockResolvedValue([]);
  closeRunIfOneShotMock.mockResolvedValue(undefined);
});

describe('POST /api/projects/:id/ux-contract/scan', () => {
  it('rejects a non-admin with a 403, never a silent no-op', async () => {
    assertProjectRoleMock.mockImplementation(() => {
      throw new HTTPException(403, { message: 'not a project admin' });
    });

    const res = await postScan();

    expect(res.status).toBe(403);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('404s when the project does not exist', async () => {
    projectRow = undefined;

    const res = await postScan();

    expect(res.status).toBe(404);
  });

  it('fails cleanly (no dead end) when no runner is bound/online', async () => {
    resolveChatDeviceMock.mockResolvedValue({ deviceId: null, isLocal: false });

    const res = await postScan();

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NO_CLAUDE_CLIENT');
    expect(createChatSessionRowMock).not.toHaveBeenCalled();
  });

  it('202s with a sessionId on the happy path, dispatching a message that carries the resolved packageDir', async () => {
    resolveChatDeviceMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      isLocal: false,
    });
    projectRow = {
      id: PROJECT_ID,
      slug: 'forge-dev',
      repoPath: '/repo',
      agentConfig: { uxContractProfile: { bindingScope: 'packages/web-v2/' } },
    };

    const res = await postScan();

    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toBe(SESSION_ID);
    expect(dispatchChatTurnMock).toHaveBeenCalledOnce();
    const dispatched = dispatchChatTurnMock.mock.calls[0]?.[0] as {
      message: string;
    };
    expect(dispatched.message).toContain('packages/web-v2');
    expect(dispatched.message).toContain('forge_ux_scan');
  });

  it('falls back to the request body packageDir, then "." when no profile/body is given', async () => {
    resolveChatDeviceMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      isLocal: false,
    });

    const res = await postScan();

    expect(res.status).toBe(202);
    const dispatched = dispatchChatTurnMock.mock.calls[0]?.[0] as {
      message: string;
    };
    expect(dispatched.message).toContain('`.`');
  });

  it('rejects a packageDir with ".." segments before it ever reaches the dispatched message', async () => {
    resolveChatDeviceMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      isLocal: false,
    });

    const res = await postScan({ packageDir: '../../etc' });

    expect(res.status).toBe(400);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('rejects a packageDir with a leading "-" (git ls-files option injection, ISS-576 review #3)', async () => {
    resolveChatDeviceMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      isLocal: false,
    });

    const res = await postScan({ packageDir: '--upload-pack=evil' });

    expect(res.status).toBe(400);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('rejects an absolute packageDir (leading "/", ISS-576 review #3)', async () => {
    resolveChatDeviceMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      isLocal: false,
    });

    const res = await postScan({ packageDir: '/etc' });

    expect(res.status).toBe(400);
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  it('an explicit request-body packageDir wins over a stored bindingScope profile (ISS-576 review #5)', async () => {
    resolveChatDeviceMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      isLocal: false,
    });
    projectRow = {
      id: PROJECT_ID,
      slug: 'forge-dev',
      repoPath: '/repo',
      agentConfig: { uxContractProfile: { bindingScope: 'packages/web-v2/' } },
    };

    const res = await postScan({ packageDir: 'apps/other' });

    expect(res.status).toBe(202);
    const dispatched = dispatchChatTurnMock.mock.calls[0]?.[0] as {
      message: string;
    };
    expect(dispatched.message).toContain('apps/other');
    expect(dispatched.message).not.toContain('packages/web-v2');
  });

  it('maps a dispatch failure to 502 after terminalizing its session and one-shot run', async () => {
    resolveChatDeviceMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      isLocal: false,
    });
    dispatchChatTurnMock.mockRejectedValue(new Error('ws publish failed'));

    const res = await postScan();

    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('DISPATCH_FAILED');
    expect(applyKernelTransitionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entity: 'session', to: 'failed', source: 'ux-contract/scan' }),
    );
    expect(closeRunIfOneShotMock).toHaveBeenCalledWith(
      '55555555-5555-4555-8555-555555555555',
      'failed',
    );
  });
});
