import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'y'.repeat(32);

vi.mock('../config/env.js', () => ({
  env: { DEVICE_TOKEN_PEPPER: TEST_PEPPER, NODE_ENV: 'test' },
}));

const verifyDeviceCredential = vi.fn(async (token: string) => {
  if (token === 'good') {
    return { id: 'dev-1', ownerId: 'u-1', status: 'offline', name: 'laptop', platform: 'linux' };
  }
  if (token === 'revoked') {
    return { id: 'dev-1', ownerId: 'u-1', status: 'revoked', name: 'laptop', platform: 'linux' };
  }
  return null;
});
vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: (t: string) => verifyDeviceCredential(t),
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const dbSelect = vi.fn(() => ({ from: selectFrom }));

vi.mock('../db/client.js', () => ({
  db: { select: dbSelect },
}));

// The resolve chain has its own suite (jobs/resolve-job-mcp-servers.test.ts),
// including the stage-less entry this route calls. Here it is stubbed so the
// assertions are about the route: the auth gates, and that what the resolver
// says travels whole.
const resolveSessionMcpServers = vi.fn(async () => ({
  mcpServers: { playwright: { type: 'stdio', command: 'npx' } } as Record<string, unknown> | null,
  resolvedNames: ['playwright'],
  droppedNames: ['epodsystem'],
}));
vi.mock('../jobs/resolve-job-mcp-servers.js', () => ({
  resolveSessionMcpServers: () => resolveSessionMcpServers(),
}));

const { deviceMcpServerRoutes } = await import('./mcp-servers-routes.js');
const { errorHandler } = await import('../middleware/error.js');
const { requestId } = await import('../middleware/request-id.js');

function buildApp() {
  const app = new Hono<{ Variables: import('../middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/devices', deviceMcpServerRoutes);
  app.onError(errorHandler);
  return app;
}

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PATH = `/api/devices/me/mcp-servers?projectId=${PROJECT_ID}`;

type Body = {
  mcpServers: Record<string, unknown>;
  resolvedNames: string[];
  droppedNames: string[];
};

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockReset();
  selectWhere.mockImplementation(() => ({ limit: selectLimit }));
});

describe('GET /api/devices/me/mcp-servers (ISS-1043)', () => {
  it('401 with a bad device token', async () => {
    const res = await buildApp().request(PATH, { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
    expect(resolveSessionMcpServers).not.toHaveBeenCalled();
  });

  it('401 when the device token is revoked', async () => {
    const res = await buildApp().request(PATH, { headers: { authorization: 'Bearer revoked' } });
    expect(res.status).toBe(401);
    expect(resolveSessionMcpServers).not.toHaveBeenCalled();
  });

  it('refuses a project this device serves no runner for, by name, and resolves nothing', async () => {
    selectLimit.mockResolvedValueOnce([]); // no runner row for (device, project)
    const res = await buildApp().request(PATH, { headers: { authorization: 'Bearer good' } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('device not bound to project');
    expect(resolveSessionMcpServers).not.toHaveBeenCalled();
  });

  it('400 on a projectId that is not a uuid, before any lookup', async () => {
    const res = await buildApp().request('/api/devices/me/mcp-servers?projectId=not-a-uuid', {
      headers: { authorization: 'Bearer good' },
    });
    expect(res.status).toBe(400);
    expect(resolveSessionMcpServers).not.toHaveBeenCalled();
  });

  it('serves the resolved specs to a device bound to the project', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'run-1' }]);
    const res = await buildApp().request(PATH, { headers: { authorization: 'Bearer good' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.mcpServers.playwright).toEqual({ type: 'stdio', command: 'npx' });
    expect(body.resolvedNames).toEqual(['playwright']);
  });

  it('carries a declared name that could not be supplied instead of dropping it silently', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'run-1' }]);
    const res = await buildApp().request(PATH, { headers: { authorization: 'Bearer good' } });
    const body = (await res.json()) as Body;
    expect(body.droppedNames).toEqual(['epodsystem']);
    expect(body.mcpServers.epodsystem).toBeUndefined();
  });

  it('answers a project with no servers as an empty map rather than null', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'run-1' }]);
    resolveSessionMcpServers.mockResolvedValueOnce({
      mcpServers: null,
      resolvedNames: [],
      droppedNames: [],
    });
    const res = await buildApp().request(PATH, { headers: { authorization: 'Bearer good' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.mcpServers).toEqual({});
  });
});
