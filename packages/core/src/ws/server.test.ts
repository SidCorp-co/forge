import { type AddressInfo, createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../auth/deviceToken.js', () => ({
  verifyDeviceToken: vi.fn(async () => null),
}));

vi.mock('../auth/cookie.js', () => ({
  AUTH_COOKIE_NAME: 'forge_auth',
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })) })),
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
}): Promise<{ status: 'open'; protocol: string } | { status: 'error'; code?: number; message: string }> {
  const url = `ws://127.0.0.1:${port}/ws${opts.query ? `?${opts.query}` : ''}`;
  return new Promise((resolve) => {
    const ws = new WebSocketLib(url, opts.protocols, { headers: opts.headers });
    ws.on('open', () => {
      const proto = ws.protocol;
      ws.close();
      resolve({ status: 'open', protocol: proto });
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: 'error', code: res.statusCode, message: res.statusMessage ?? '' });
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

// ISS-2A — any authenticated principal can subscribe to the cross-tenant
// `global` room used for builtin skill update broadcasts. The DB is mocked
// to return no rows so this also confirms subscribe to `'global'` does not
// hit any project-membership lookup.
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
      // Null = no denial message arrived within the grace window.
      expect(result).toBeNull();
    } finally {
      ws.close();
    }
  });
});
