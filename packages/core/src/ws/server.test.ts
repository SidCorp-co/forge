import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// /ws upgrade auth — exercises the canonical Sec-WebSocket-Protocol
// subprotocol path, Bearer header, cookie, and rejection cases. The
// legacy `?token=<jwt>` query path was removed in ISS-315 cleanup. DB
// and verifier modules are mocked so the test stays in-process.

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';
const VALID_USER_TOKEN = 'valid-user-token';
const INVALID_TOKEN = 'invalid-token';
const USER_ID = 'user-1';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

vi.mock('../auth/jwt.js', () => ({
  verifyUserToken: vi.fn(async (token: string) => {
    if (token === VALID_USER_TOKEN) return { sub: USER_ID, typ: 'user' };
    throw new Error('invalid');
  }),
}));

vi.mock('../auth/device-credential.js', () => ({
  verifyDeviceCredential: vi.fn(async () => null),
}));

vi.mock('../auth/cookie.js', () => ({
  AUTH_COOKIE_NAME: 'forge_auth',
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
    })),
  },
}));

vi.mock('../db/schema.js', () => ({
  devices: {},
  projectMembers: {},
  runners: {},
}));

vi.mock('../runners/heartbeat-ws.js', () => ({
  handleRunnerRegister: vi.fn(),
  handleRunnerUnregister: vi.fn(),
  handleRunnerUpdate: vi.fn(),
}));

vi.mock('../lib/feature-flags.js', () => ({
  isEnabled: () => false,
}));

const effectiveProjectRoleMock = vi.fn(
  async (_userId: string, _projectId: string): Promise<{ role: string | null } | null> => null,
);
vi.mock('../lib/authz.js', () => ({
  effectiveProjectRole: (userId: string, projectId: string) =>
    effectiveProjectRoleMock(userId, projectId),
}));

const isPlatformAdminMock = vi.fn(async (_userId: string): Promise<boolean> => false);
vi.mock('../middleware/require-admin.js', () => ({
  isPlatformAdmin: (userId: string) => isPlatformAdminMock(userId),
}));

const { attachWs, closeWs } = await import('./server.js');
const WebSocketLib = (await import('ws')).WebSocket;

let server: ReturnType<typeof createServer>;
let port: number;

beforeAll(async () => {
  server = createServer();
  attachWs(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await closeWs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.clearAllMocks();
});

function dial(opts: {
  protocols?: string | string[];
  query?: string;
  headers?: Record<string, string>;
}): Promise<
  { status: 'open'; protocol: string } | { status: 'error'; code?: number; message: string }
> {
  const url = `ws://127.0.0.1:${port}/ws${opts.query ? `?${opts.query}` : ''}`;
  return new Promise((resolve) => {
    const ws = new WebSocketLib(url, opts.protocols, { headers: opts.headers });
    ws.on('open', () => {
      const proto = ws.protocol;
      ws.close();
      resolve({ status: 'open', protocol: proto });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({
        status: 'error',
        ...(res.statusCode !== undefined ? { code: res.statusCode } : {}),
        message: res.statusMessage ?? '',
      });
    });
    ws.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ status: 'error', message: err.message });
    });
  });
}

describe('/ws auth — Sec-WebSocket-Protocol subprotocol (ISS-286)', () => {
  it('upgrades when client offers `forge.bearer.<jwt>` and echoes the protocol back', async () => {
    const result = await dial({ protocols: [`forge.bearer.${VALID_USER_TOKEN}`] });
    expect(result.status).toBe('open');
    if (result.status === 'open') {
      expect(result.protocol).toBe(`forge.bearer.${VALID_USER_TOKEN}`);
    }
  });

  it('rejects with 401 when the subprotocol carries an invalid JWT', async () => {
    const result = await dial({ protocols: [`forge.bearer.${INVALID_TOKEN}`] });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(401);
    }
  });

  it('falls back to cookie auth when no subprotocol token offered', async () => {
    const result = await dial({
      headers: { Cookie: `forge_auth=${VALID_USER_TOKEN}` },
    });
    expect(result.status).toBe('open');
  });

  it('rejects `?token=<jwt>` query with 401 (legacy path removed in ISS-315 cleanup)', async () => {
    const result = await dial({ query: `token=${VALID_USER_TOKEN}` });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(401);
    }
  });

  it('still accepts Authorization: Bearer header (Tauri Rust client path)', async () => {
    const result = await dial({
      headers: { Authorization: `Bearer ${VALID_USER_TOKEN}` },
    });
    expect(result.status).toBe('open');
  });

  it('ignores subprotocols outside the `forge.bearer.` namespace', async () => {
    const result = await dial({ protocols: ['chat.v1'] });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(401);
    }
  });
});

// cm:guard the db mock returns NO rows on purpose, and that is the assertion: subscribing to the cross-tenant `global` room must not reach a project-membership lookup at all. A mock that returned a membership would make this suite pass whether or not the lookup happens (ISS-2A).
describe('/ws subscribe — global room (ISS-2A)', () => {
  function dialPersistent(opts: {
    protocols?: string | string[];
    headers?: Record<string, string>;
  }): Promise<import('ws').WebSocket> {
    const url = `ws://127.0.0.1:${port}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocketLib(url, opts.protocols, { headers: opts.headers });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('user principal can subscribe to "global" without a project membership lookup', async () => {
    const ws = await dialPersistent({ protocols: [`forge.bearer.${VALID_USER_TOKEN}`] });
    try {
      const denial = new Promise<unknown>((resolve, reject) => {
        const t = setTimeout(() => resolve(null), 200);
        ws.on('message', (buf) => {
          clearTimeout(t);
          try {
            const msg = JSON.parse(buf.toString());
            if (msg?.event === 'subscribe.denied') resolve(msg);
            else reject(new Error(`unexpected message ${buf.toString()}`));
          } catch (err) {
            reject(err);
          }
        });
      });
      ws.send(JSON.stringify({ type: 'subscribe', room: 'global' }));
      const result = await denial;
      expect(result).toBeNull();
    } finally {
      ws.close();
    }
  });
});

// cm:guard the allow-list is a SECOND way into a `project:` room, not a replacement for membership — both arms need a test, because dropping either one fails silently: no denial is sent for a room the client simply never receives events on (ISS-653)
describe('/ws subscribe — project room (ISS-653)', () => {
  const PROJECT_ROOM = 'project:11111111-1111-4111-8111-111111111111';

  function dialPersistent(): Promise<import('ws').WebSocket> {
    const url = `ws://127.0.0.1:${port}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocketLib(url, [`forge.bearer.${VALID_USER_TOKEN}`]);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  /** Resolves with the `subscribe.denied` envelope, or null when none arrived. */
  async function subscribeOutcome(): Promise<unknown> {
    const ws = await dialPersistent();
    try {
      const denial = new Promise<unknown>((resolve, reject) => {
        const t = setTimeout(() => resolve(null), 200);
        ws.on('message', (buf) => {
          clearTimeout(t);
          try {
            const msg = JSON.parse(buf.toString());
            if (msg?.event === 'subscribe.denied') resolve(msg);
            else reject(new Error(`unexpected message ${buf.toString()}`));
          } catch (err) {
            reject(err);
          }
        });
      });
      ws.send(JSON.stringify({ type: 'subscribe', room: PROJECT_ROOM }));
      return await denial;
    } finally {
      ws.close();
    }
  }

  it('denies a non-member who is not on the ADMIN_EMAILS allow-list', async () => {
    effectiveProjectRoleMock.mockResolvedValueOnce(null);
    isPlatformAdminMock.mockResolvedValueOnce(false);

    expect(await subscribeOutcome()).toMatchObject({
      event: 'subscribe.denied',
      data: { room: PROJECT_ROOM },
    });
  });

  it('admits a platform admin who is a member of nothing', async () => {
    effectiveProjectRoleMock.mockResolvedValueOnce(null);
    isPlatformAdminMock.mockResolvedValueOnce(true);

    expect(await subscribeOutcome()).toBeNull();
    expect(isPlatformAdminMock).toHaveBeenCalledWith(USER_ID);
  });

  it('admits a member without reading the allow-list at all', async () => {
    effectiveProjectRoleMock.mockResolvedValueOnce({ role: 'viewer' });

    expect(await subscribeOutcome()).toBeNull();
    expect(isPlatformAdminMock).not.toHaveBeenCalled();
  });
});
