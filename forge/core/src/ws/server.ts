import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { and, eq } from 'drizzle-orm';
import { type WebSocket, WebSocketServer } from 'ws';
import { AUTH_COOKIE_NAME } from '../auth/cookie.js';
import { verifyDeviceToken } from '../auth/deviceToken.js';
import { verifyUserToken } from '../auth/jwt.js';
import { db } from '../db/client.js';
import { devices, projectMembers, runners } from '../db/schema.js';
import { isEnabled } from '../lib/feature-flags.js';
import {
  handleRunnerRegister,
  handleRunnerUnregister,
  handleRunnerUpdate,
} from '../runners/heartbeat-ws.js';
import { RoomManager } from './rooms.js';

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

function parseQueryToken(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // url is the request path like "/ws?token=..." — parse via URL helper
  try {
    const u = new URL(url, 'http://placeholder');
    const t = u.searchParams.get('token');
    return t ? t : undefined;
  } catch {
    return undefined;
  }
}

async function tryUserToken(token: string): Promise<Principal | null> {
  try {
    const claims = await verifyUserToken(token);
    return { type: 'user', userId: claims.sub };
  } catch {
    return null;
  }
}

async function authenticate(req: IncomingMessage): Promise<Principal | null> {
  const bearer = parseBearer(req.headers.authorization);
  if (bearer) {
    const user = await tryUserToken(bearer);
    if (user) return user;
    const device = await verifyDeviceToken(bearer);
    if (device) return { type: 'device', deviceId: device.id, ownerId: device.ownerId };
    return null;
  }

  // Browser WebSocket API can't set Authorization headers, so fall back to
  // a `?token=<jwt>` URL query (Tauri / cross-origin web clients). Cookies
  // also fall through here for same-origin browser sessions.
  const queryToken = parseQueryToken(req.url);
  if (queryToken) {
    const user = await tryUserToken(queryToken);
    if (user) return user;
    const device = await verifyDeviceToken(queryToken);
    if (device) return { type: 'device', deviceId: device.id, ownerId: device.ownerId };
    // Don't fall through to cookie — caller explicitly chose query auth.
    return null;
  }

  const cookie = parseCookie(req.headers.cookie, AUTH_COOKIE_NAME);
  if (cookie) {
    return tryUserToken(cookie);
  }

  return null;
}

async function canSubscribe(principal: Principal, room: string): Promise<boolean> {
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
      const principal = await authenticate(req);
      if (!principal) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!wss) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (raw) => {
        const ws = raw as AliveSocket;
        ws.isAlive = true;
        ws.principal = principal;
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
        isEnabled('runnerFramework') &&
        (type === 'runner:register' || type === 'runner:unregister' || type === 'runner:update')
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
