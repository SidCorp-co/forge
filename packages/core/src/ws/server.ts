import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { type WebSocket, WebSocketServer } from 'ws';
import { AUTH_COOKIE_NAME, cookieValues } from '../credentials/cookie.js';
import { verifyDeviceToken } from '../credentials/device-credential.js';
import { verifyUserToken } from '../credentials/jwt.js';
import { type PatScope, runWithPatScope } from '../credentials/pat-scope.js';
import { deviceOwnedBy, handleRunnerSessions } from '../devices/index.js';
import { roomManager } from '../lib/rooms.js';
import { markWsListening } from '../lib/ws-listening.js';
import { isPlatformAdmin } from '../middleware/require-admin.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { runnerPlacement } from '../runners/index.js';

type AnyServer = HttpServer | HttpsServer;

let wss: WebSocketServer | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

type Principal =
  | { type: 'user'; userId: string }
  | { type: 'device'; deviceId: string; ownerId: string; scope: PatScope };

interface AliveSocket extends WebSocket {
  isAlive: boolean;
  principal: Principal;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * A subscribe may ask for the frames its room published in the last `replayMs`, measured on the
 * client from when its page started reading: the reads it made before this socket heard anything.
 * The span is widened by the time the subscribe waited on its gate here, and by its own trip,
 * which neither side can see.
 */
const REPLAY_SLACK_MS = 2_000;

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

function parseProtocolToken(header: string | string[] | undefined): ProtocolMatch | undefined {
  if (!header) return undefined;
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

/**
 * Who a bearer on the upgrade is: a person, or a paired box. A token core handed a chat is neither
 * (`device-credential.ts:readBoxToken`), so the socket a runner holds never opens for it (REQ-30 BC-4).
 */
export async function resolveBearer(token: string): Promise<Principal | null> {
  const user = await tryUserToken(token);
  if (user) return user;
  const box = await verifyDeviceToken(token);
  if (box) {
    return {
      type: 'device',
      deviceId: box.device.id,
      ownerId: box.device.ownerId,
      scope: box.scope,
    };
  }
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

  // Same-origin browser path — the first forge_auth cookie that verifies, so a sibling
  // instance's parent-domain cookie sent first does not refuse the socket.
  for (const cookie of cookieValues(req.headers.cookie, AUTH_COOKIE_NAME)) {
    const user = await tryUserToken(cookie);
    if (user) return { principal: user };
  }

  return null;
}

const userOf = (p: Principal) => (p.type === 'user' ? p.userId : p.ownerId);

/** project.read on the project, asked as the principal: a box answers within its token's fence,
 *  never with its owner's whole reach (a person-held box is fenced to no project). */
async function readsProject(principal: Principal, projectId: string): Promise<boolean> {
  const ask = () => can(actorFor(userOf(principal)), 'project.read', projectResource(projectId));
  return principal.type === 'device' ? runWithPatScope(principal.scope, ask) : ask();
}

async function canSubscribe(principal: Principal, room: string): Promise<boolean> {
  if (room.startsWith('project:')) {
    const projectId = room.slice('project:'.length);
    if (await readsProject(principal, projectId)) return true;
    return principal.type === 'user' && (await isPlatformAdmin(principal.userId));
  }
  if (room.startsWith('device:')) {
    const deviceId = room.slice('device:'.length);
    if (principal.type === 'device') return principal.deviceId === deviceId;
    return deviceOwnedBy(deviceId, principal.userId);
  }
  if (room.startsWith('user:')) {
    return userOf(principal) === room.slice('user:'.length);
  }
  if (room.startsWith('runner:')) {
    const runnerId = room.slice('runner:'.length);
    const row = await runnerPlacement(runnerId);
    if (!row) return false;
    if (principal.type === 'device') {
      return row.deviceId === principal.deviceId;
    }
    return readsProject(principal, row.projectId);
  }
  return false;
}

export function attachWs(server: AnyServer): void {
  if (wss) return;

  wss = new WebSocketServer({ noServer: true });
  markWsListening(true);

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
      const { type, room, replayMs } = msg as {
        type?: unknown;
        room?: unknown;
        replayMs?: unknown;
      };
      if (type === 'runner:sessions') {
        if (ws.principal.type === 'device') {
          void handleRunnerSessions(ws as unknown as import('ws').WebSocket, msg);
        }
        return;
      }
      if (typeof room !== 'string' || room.length === 0) return;

      if (type === 'subscribe') {
        const receivedAt = Date.now();
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
            } catch {}
            return;
          }
          roomManager.subscribe(ws, room);
          if (typeof replayMs === 'number' && Number.isFinite(replayMs) && replayMs >= 0) {
            const waited = Date.now() - receivedAt;
            const replay = roomManager.replay(ws, room, replayMs + waited + REPLAY_SLACK_MS);
            try {
              ws.send(
                JSON.stringify({
                  event: 'replay.done',
                  data: { room, ...replay },
                  timestamp: new Date().toISOString(),
                }),
              );
            } catch {}
          }
        })();
      } else if (type === 'unsubscribe') {
        roomManager.unsubscribe(ws, room);
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

const WS_CLOSE_FALLBACK_MS = 2_000;

export async function closeWs(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (!wss) return;
  const server = wss;
  wss = null;
  markWsListening(false);
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
