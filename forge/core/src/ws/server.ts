import type { Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import { type WebSocket, WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';

type AnyServer = HttpServer | HttpsServer;

export const roomManager = new RoomManager();

let wss: WebSocketServer | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

type PrincipalType = 'user' | 'device' | 'anonymous';

interface AliveSocket extends WebSocket {
  isAlive: boolean;
  principalType: PrincipalType;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export function attachWs(server: AnyServer): void {
  if (wss) return;

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (raw, req) => {
    const ws = raw as AliveSocket;
    ws.isAlive = true;

    // Auth placeholder (Phase 2.0-E): log principal type, do not enforce.
    // Policy + rejection land in Phase 2.2.
    const authz = req.headers.authorization;
    const deviceTok = req.headers['x-device-token'];
    ws.principalType = authz ? 'user' : deviceTok ? 'device' : 'anonymous';
    console.log(`[ws] connection principalType=${ws.principalType}`);

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
        roomManager.subscribe(ws, room);
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

export function isWsListening(): boolean {
  return wss !== null;
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
