import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { and, eq } from 'drizzle-orm';
import { type WebSocket, WebSocketServer } from 'ws';
import { AUTH_COOKIE_NAME } from '../auth/cookie.js';
import { verifyDeviceCredential } from '../auth/device-credential.js';
import { verifyUserToken } from '../auth/jwt.js';
import { db } from '../db/client.js';
import { devices, runners } from '../db/schema.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { isPlatformAdmin } from '../middleware/require-admin.js';
import {
  handleRunnerRegister,
  handleRunnerUnregister,
  handleRunnerUpdate,
} from '../runners/heartbeat-ws.js';
import { roomManager } from './room-manager.js';
import { GLOBAL_ROOM } from './rooms.js';

type AnyServer = HttpServer | HttpsServer;

// cm:edge naming -> packages/core/src/ws/room-manager.ts — re-exported so the 27 existing `from '../ws/server.js'` imports keep working; the instance lives there because importing it from here dragged the whole server, and its heartbeat handlers, into every publisher
export { roomManager };

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

// cm:guard return the EXACT protocol string matched, not the token alone — a browser rejects an upgrade whose `Sec-WebSocket-Protocol` response header does not echo the subprotocol it offered, and the handler has nothing else to echo
function parseProtocolToken(header: string | string[] | undefined): ProtocolMatch | undefined {
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

// cm:guard `/ws` is the daemon's own channel and a device is still the principal on it (ISS-931 rule 4) — what changed in ISS-932 is only HOW the box proves it is one: a PAT/AAT carrying `device_id`, verified straight through `verifyPat`. It deliberately does NOT go through `authenticatePat`: that charges the per-minute REST bucket and emits `pat.used`, and a socket authenticates once for a connection that then lives for hours, so metering it as one request per hour would make the token's rate-limit headers lie about what it is doing.
async function resolveBearer(token: string): Promise<Principal | null> {
  const user = await tryUserToken(token);
  if (user) return user;
  const device = await verifyDeviceCredential(token);
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
  // and every live client (packages/dev subprotocol, web cookie) had
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
    const access = await effectiveProjectRole(userId, projectId);
    if (access?.role) return true;
    // cm:edge contract -> packages/core/src/admin/aggregate-routes.ts — the Operator Ops Console reads every tenant over `/api/admin/*` on this same ADMIN_EMAILS allow-list, and the live half of that screen rides `pipeline_run.status_changed` in each project's room; without this an admin sees cross-tenant numbers that only refresh for the projects they happen to be a member of
    // cm:guard this widens READ only — the room carries invalidation events, and a project room's publishers never accept input from a subscriber. Anything that ever gives a room a write side must gate it on membership again here, not on this branch.
    return await isPlatformAdmin(userId);
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
    // user — must have an effective role on the runner's project.
    const access = await effectiveProjectRole(principal.userId, row.projectId);
    return !!access?.role;
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
                JSON.stringify({
                  event: 'subscribe.denied',
                  data: { room },
                  timestamp: new Date().toISOString(),
                }),
              );
            } catch {
              // cm:why a socket may close between the room read and the write, and a throw here would abort the whole publish loop — the remaining subscribers would silently miss the frame.
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
