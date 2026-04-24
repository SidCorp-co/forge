import WebSocket from 'ws';
import type { TestServer } from './app-server.js';

/**
 * A second ws client representing the web dashboard. Authenticates as a user
 * (JWT in `Authorization`), subscribes to `project:<id>`, and records every
 * inbound frame with an arrival timestamp. Used by the Phase 2.7-F2 E2E
 * (ISS-218) to prove server → web broadcasts fire end-to-end.
 */

export interface ObservedEvent {
  event: string;
  data: unknown;
  at: number;
}

export interface WebObserver {
  events: ObservedEvent[];
  waitFor(pred: (ev: ObservedEvent) => boolean, timeoutMs: number): Promise<ObservedEvent>;
  close(): Promise<void>;
}

export interface StartWebObserverOpts {
  server: TestServer;
  userJwt: string;
  projectId: string;
}

export async function startWebObserver(opts: StartWebObserverOpts): Promise<WebObserver> {
  const events: ObservedEvent[] = [];

  const ws = new WebSocket(opts.server.wsUrl, {
    headers: { authorization: `Bearer ${opts.userJwt}` },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  ws.on('message', (buf) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const { event, data } = parsed as { event?: unknown; data?: unknown };
    if (typeof event !== 'string') return;
    events.push({ event, data, at: performance.now() });
  });

  ws.send(JSON.stringify({ type: 'subscribe', room: `project:${opts.projectId}` }));
  await new Promise((r) => setTimeout(r, 20));

  async function waitFor(
    pred: (ev: ObservedEvent) => boolean,
    timeoutMs: number,
  ): Promise<ObservedEvent> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `WebObserver.waitFor: timeout after ${timeoutMs}ms. Recorded: ${JSON.stringify(
        events.map((e) => e.event),
      )}`,
    );
  }

  async function close(): Promise<void> {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000);
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });
    }
  }

  return { events, waitFor, close };
}
