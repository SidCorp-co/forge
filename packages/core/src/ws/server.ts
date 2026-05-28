import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { and, eq } from 'drizzle-orm';
import { type WebSocket, WebSocketServer } from 'ws';
import { AUTH_COOKIE_NAME } from '../auth/cookie.js';
import { verifyDeviceToken } from '../auth/deviceToken.js';
import { verifyUserToken } from '../auth/jwt.js';
import { db } from '../db/client.js';
import { devices, projectMembers, runners } from '../db/schema.js';
import {
  handleRunnerRegister,
  handleRunnerUnregister,
  handleRunnerUpdate,
} from '../runners/heartbeat-ws.js';
import { GLOBAL_ROOM, RoomManager } from './rooms.js';

type AnyServer = HttpServer | HttpsServer;

export const roomManager = new RoomManager();

let wss: WebSocketServer | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

type Principal =
  | { type: 'user'; userId: string }
  | { type: 'device'; deviceId: string; ownerId: string };

interface AliveSocket extends WebSocket {
  isAlive: boolean;
  principal: Principal;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function parseBearer(header: string | string[] | undefined): string | undefined {
  if (!header) return undefined;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m?.[1]?.trim();
}

const SUBPROTOCOL_TOKEN_PREFIX = 'forge.bearer.';

interface ProtocolMatch {
  token: string;
  protocol: string;
}

// Browsers require the server to echo the chosen subprotocol back via the
// `Sec-WebSocket-Protocol` response header — otherwise the upgrade is
// rejected client-side. Returns both the bearer token and the exact
// protocol string we matched so the upgrade handler can echo it back.
function parseProtocolToken(
  header: string | string[] | undefined,
): ProtocolMatch | undefined {
  if (!header) return undefined;
  // Node's http parser collapses repeats into a single comma-joined string
  // but some runtimes hand back an array; handle both.
  const raw = Array.isArray(header) ? header.join(',') : header;
  for (const part of raw.split(',')) {
    const proto = part.trim();
    if (!proto.startsWith(SUBPROTOCOL_TOKEN_PREFIX)) continue;
    const token = proto.slice(SUBPROTOCOL_TOKEN_PREFIX.length);
    if (!token) continue;
    return { token, protocol: proto };
  }
  return undefined;
}

async function tryUserToken(token: string): Promise<Principal | null> {
  try {
    const claims = await verifyUserToken(token);
    return { type: 'user', userId: claims.sub };
  } catch {
    return null;
  }
}

interface AuthResult {
  principal: Principal;
  // If non-null, the upgrade handler MUST echo this subprotocol in the
  // response so the browser accepts the connection.
  acceptedProtocol?: string;
}

async function resolveBearer(token: string): Promise<Principal | null> {
  const user = await tryUserToken(token);
  if (user) return user;
  const device = await verifyDeviceToken(token);
  if (device) return { type: 'device', deviceId: device.id, ownerId: device.ownerId };
  return null;
}

async function authenticate(req: IncomingMessage): Promise<AuthResult | null> {
  // Authorization header — used by the Tauri Rust client and other native
  // callers that can set arbitrary headers on the upgrade request.
  const bearer = parseBearer(req.headers.authorization);
  if (bearer) {
    const principal = await resolveBearer(bearer);
    return principal ? { principal } : null;
  }

  // Sec-WebSocket-Protocol — browsers can't set Authorization on a WS
  // upgrade but they CAN advertise subprotocols. We match the
  // `forge.bearer.<jwt>` namespace and echo it back from the upgrade
  // handler so the handshake completes.
  const proto = parseProtocolToken(req.headers['sec-websocket-protocol']);
  if (proto) {
    const principal = await resolveBearer(proto.token);
    return principal ? { principal, acceptedProtocol: proto.protocol } : null;
  }

  // Same-origin browser path — auth via the forge_auth cookie.
  const cookie = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
  if (cookie) {
    const user = await tryUserToken(cookie);
    return user ? { principal: user } : null;
  }

  // The legacy `?token=<jwt>` query path was removed in ISS-315 cleanup —
  // it leaked the JWT into nginx access logs / Referer / browser history,
  // and every live client (packages/dev subprotocol, packages/web cookie) had
  // already migrated off it. Anyone still passing the query is treated as
  // unauthenticated.
  return null;
}

async function canSubscribe(principal: Principal, room: string): Promise<boolean> {
  // Global broadcast room — server-emitted cross-tenant events (e.g. builtin
  // skill seeding). Any authenticated principal may join; the upgrade
  // handler has already established authentication.
  if (room === GLOBAL_ROOM) return true;
  if (room.startsWith('project:')) {
    const projectId = room.slice('project:'.length);
    const userId = principal.type === 'user' ? principal.userId : principal.ownerId;
    const [row] = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    return !!row;
  }
  if (room.startsWith('device:')) {
    const deviceId = room.slice('device:'.length);
    if (principal.type === 'device') return principal.deviceId === deviceId;
    const [row] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.ownerId, principal.userId)))
      .limit(1);
    return !!row;
  }
  if (room.startsWith('user:')) {
    const userId = room.slice('user:'.length);
    const principalUserId = principal.type === 'user' ? principal.userId : principal.ownerId;
    return principalUserId === userId;
  }
  if (room.startsWith('runner:')) {
    const runnerId = room.slice('runner:'.length);
    const [row] = await db
      .select({ deviceId: runners.deviceId, projectId: runners.projectId })
      .from(runners)
      .where(eq(runners.id, runnerId))
      .limit(1);
    if (!row) return false;
    if (principal.type === 'device') {
      return row.deviceId === principal.deviceId;
    }
    // user — must be a project member.
    const [member] = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, row.projectId), eq(projectMembers.userId, principal.userId)),
      )
      .limit(1);
    return !!member;
  }
  return false;
}

export function attachWs(server: AnyServer): void {
  if (wss) return;

  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return;

    void (async () => {
      const result = await authenticate(req);
      if (!result) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!wss) {
        socket.destroy();
        return;
      }
      // When the client used Sec-WebSocket-Protocol auth, mutate the request
      // headers so the underlying ws library's selectProtocol picks our
      // accepted subprotocol and echoes it on the response. Browsers reject
      // the upgrade otherwise.
      if (result.acceptedProtocol) {
        req.headers['sec-websocket-protocol'] = result.acceptedProtocol;
      }
      wss.handleUpgrade(req, socket, head, (raw) => {
        const ws = raw as AliveSocket;
        ws.isAlive = true;
        ws.principal = result.principal;
        wss?.emit('connection', ws, req);
      });
    })();
  });

  wss.on('connection', (raw) => {
    const ws = raw as AliveSocket;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (buf) => {
      let msg: unknown;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const { type, room } = msg as { type?: unknown; room?: unknown };
      if (typeof room !== 'string' || room.length === 0) return;

      if (type === 'subscribe') {
        void (async () => {
          const allowed = await canSubscribe(ws.principal, room).catch(() => false);
          if (!allowed) {
            try {
              ws.send(
                JSON.stringify({ event: 'subscribe.denied', data: { room }, timestamp: new Date().toISOString() }),
              );
            } catch {
              // socket may be closed; ignore
            }
            return;
          }
          roomManager.subscribe(ws, room);
        })();
      } else if (type === 'unsubscribe') {
        roomManager.unsubscribe(ws, room);
      } else if (
        type === 'runner:register' ||
        type === 'runner:unregister' ||
        type === 'runner:update'
      ) {
        if (ws.principal.type !== 'device') return;
        if (type === 'runner:register') {
          void handleRunnerRegister(ws as unknown as import('ws').WebSocket, msg);
        } else if (type === 'runner:unregister') {
          void handleRunnerUnregister(ws as unknown as import('ws').WebSocket, msg);
        } else {
          void handleRunnerUpdate(ws as unknown as import('ws').WebSocket, msg);
        }
      }
    });

    ws.on('close', () => {
      roomManager.removeAll(ws);
    });

    ws.on('error', (err) => {
      console.error('[ws] client error', err);
    });
  });

  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      const s = client as AliveSocket;
      if (!s.isAlive) {
        s.terminate();
        continue;
      }
      s.isAlive = false;
      s.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

export function isWsListening(): boolean {
  return wss !== null;
}

export function wsClientCount(): number {
  return wss ? wss.clients.size : 0;
}

const WS_CLOSE_FALLBACK_MS = 2_000;

export async function closeWs(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (!wss) return;
  const server = wss;
  wss = null;
  // Notify clients with 1001 (going away); fall back to terminate if any
  // client fails to close within the grace window so `server.close()` resolves.
  for (const client of server.clients) client.close(1001, 'server shutting down');
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const fallback = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      for (const client of server.clients) client.terminate();
      resolve();
    }, WS_CLOSE_FALLBACK_MS);
    t.unref?.();
  });
  await Promise.race([closed, fallback]);
  await closed;
}
