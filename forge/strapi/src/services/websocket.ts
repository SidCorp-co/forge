import { WebSocketServer, WebSocket } from 'ws';
import type { Core } from '@strapi/strapi';

let wss: WebSocketServer | null = null;
const sessionSubscriptions = new Map<string, Set<WebSocket>>();
const sessionCallbacks = new Map<string, Set<(event: string, data: unknown) => void>>();
const deviceClients = new Map<string, WebSocket>();

const PING_INTERVAL_MS = 30_000; // 30s

export function initWebSocket(strapi: Core.Strapi) {
  const server = strapi.server.httpServer;
  if (!server) {
    strapi.log.warn('No HTTP server found, WebSocket disabled');
    return;
  }

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('error', (err) => {
    strapi.log.error(`WebSocket server error: ${err}`);
  });

  // Server-side ping to detect dead connections
  const pingInterval = setInterval(() => {
    if (!wss) return;
    const now = Date.now();
    wss.clients.forEach((ws) => {
      if ((ws as any)._isAlive === false) {
        const deviceId = (ws as any)._deviceId as string | undefined;
        const lastPing = (ws as any)._lastPing || 0;
        strapi.log.warn(`[ws] ${deviceId || 'unknown'} failed ping (no pong in ${now - lastPing}ms) — terminating`);
        ws.terminate();
        return;
      }
      (ws as any)._isAlive = false;
      (ws as any)._lastPing = now;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(pingInterval));

  wss.on('connection', (ws) => {
    (ws as any)._isAlive = true;
    strapi.log.info('WebSocket client connected');

    ws.on('pong', () => {
      (ws as any)._isAlive = true;
      // Refresh lastSeen periodically (throttled: only if >2 min since last update)
      const deviceId = (ws as any)._deviceId;
      const now = Date.now();
      if (deviceId && now - ((ws as any)._lastSeenUpdate || 0) > 120_000) {
        (ws as any)._lastSeenUpdate = now;
        strapi.documents('api::device.device' as any).findMany({
          filters: { deviceId: { $eq: deviceId } },
          limit: 1,
        }).then((devices: any[]) => {
          if (devices[0]) {
            strapi.documents('api::device.device' as any).update({
              documentId: devices[0].documentId,
              data: { lastSeen: new Date().toISOString() },
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    });

    ws.on('message', (raw) => {
      // Any message counts as alive (in case pong is swallowed)
      (ws as any)._isAlive = true;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.sessionId) {
          let subs = sessionSubscriptions.get(msg.sessionId);
          if (!subs) {
            subs = new Set();
            sessionSubscriptions.set(msg.sessionId, subs);
          }
          subs.add(ws);
          strapi.log.info(`[ws] Client subscribed to session ${msg.sessionId} (${subs.size} total)`);
        } else if (msg.type === 'unsubscribe' && msg.sessionId) {
          sessionSubscriptions.get(msg.sessionId)?.delete(ws);
        } else if (msg.type === 'desktop:register' && msg.deviceId) {
          const existing = deviceClients.get(msg.deviceId);
          const isRebind = existing === ws;
          deviceClients.set(msg.deviceId, ws);
          (ws as any)._deviceId = msg.deviceId;
          if (isRebind) {
            strapi.log.debug(`Desktop device re-registered (keepalive): ${msg.deviceId}`);
          } else {
            strapi.log.info(`Desktop device registered: ${msg.deviceId}`);
            broadcast('desktop:connected', { deviceId: msg.deviceId });
          }
          // Update lastSeen so web UI shows device as online
          strapi.documents('api::device.device' as any).findMany({
            filters: { deviceId: { $eq: msg.deviceId } },
            limit: 1,
          }).then((devices: any[]) => {
            if (devices[0]) {
              strapi.documents('api::device.device' as any).update({
                documentId: devices[0].documentId,
                data: { lastSeen: new Date().toISOString() },
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      } catch { /* ignore non-JSON messages */ }
    });

    ws.on('error', (err) => {
      strapi.log.error(`WebSocket client error: ${err}`);
    });

    ws.on('close', () => {
      for (const subs of sessionSubscriptions.values()) {
        subs.delete(ws);
      }
      const deviceId = (ws as any)._deviceId as string | undefined;
      if (deviceId && deviceClients.get(deviceId) === ws) {
        deviceClients.delete(deviceId);
        strapi.log.info(`Desktop device disconnected: ${deviceId}`);
        broadcast('desktop:disconnected', { deviceId });
      }
      strapi.log.info('WebSocket client disconnected');
    });
  });

  strapi.log.info('WebSocket server started on /ws');
}

export function broadcast(event: string, data: unknown) {
  if (!wss) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// HTTP-register/unregister are retained as no-ops so older desktop builds
// that still POST to /agent-sessions/desktop/{register,unregister} do not 500.
// Liveness is determined solely by an open WebSocket with a matching deviceId
// sent via `desktop:register` (and periodic re-registration as keepalive).
export function registerDevice(_deviceId: string) {
  // no-op
}

export function unregisterDevice(_deviceId: string) {
  // no-op
}

export function isDeviceConnected(deviceId: string): boolean {
  const ws = deviceClients.get(deviceId);
  return ws?.readyState === WebSocket.OPEN;
}

/** Check if any desktop device is connected (for backward compat). */
export function isAnyDeviceConnected(): boolean {
  for (const ws of deviceClients.values()) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/** Return all connected device IDs. */
export function getConnectedDeviceIds(): string[] {
  const ids: string[] = [];
  for (const [id, ws] of deviceClients) {
    if (ws.readyState === WebSocket.OPEN) ids.push(id);
  }
  return ids;
}

/** Send a message to a specific device by deviceId. Returns true if sent. */
export function sendToDevice(deviceId: string, event: string, data: unknown): boolean {
  const ws = deviceClients.get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    globalThis.strapi?.log?.warn(`[ws] sendToDevice(${deviceId}, ${event}): not connected (ws=${!!ws}, state=${ws?.readyState})`);
    return false;
  }
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  ws.send(message);
  return true;
}

export function sendToSession(sessionId: string, event: string, data: unknown) {
  const subs = sessionSubscriptions.get(sessionId);
  if (!subs || subs.size === 0) {
    globalThis.strapi?.log?.debug(`[ws] sendToSession(${sessionId}, ${event}): no subscribers`);
  } else {
    globalThis.strapi?.log?.debug(`[ws] sendToSession(${sessionId}, ${event}): ${subs.size} subscriber(s)`);
    const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }

  // Notify programmatic listeners (SSE bridge, etc.)
  const cbs = sessionCallbacks.get(sessionId);
  if (cbs) {
    for (const cb of cbs) {
      try { cb(event, data); } catch { /* ignore callback errors */ }
    }
  }
}

/**
 * Wait until at least one client subscribes to a session.
 * Resolves immediately if already subscribed, otherwise polls.
 */
export function waitForSubscriber(sessionId: string, timeoutMs = 5000): Promise<boolean> {
  const subs = sessionSubscriptions.get(sessionId);
  if (subs && subs.size > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const interval = 100;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += interval;
      const s = sessionSubscriptions.get(sessionId);
      if (s && s.size > 0) {
        clearInterval(timer);
        resolve(true);
      } else if (elapsed >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, interval);
  });
}

/** Subscribe to session events programmatically. Returns an unsubscribe function. */
export function onSessionEvent(sessionId: string, callback: (event: string, data: unknown) => void): () => void {
  let cbs = sessionCallbacks.get(sessionId);
  if (!cbs) {
    cbs = new Set();
    sessionCallbacks.set(sessionId, cbs);
  }
  cbs.add(callback);
  return () => {
    cbs!.delete(callback);
    if (cbs!.size === 0) sessionCallbacks.delete(sessionId);
  };
}
