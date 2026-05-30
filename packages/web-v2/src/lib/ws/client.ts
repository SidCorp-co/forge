'use client';

// Ported verbatim from `packages/web/src/lib/ws/client.ts` (ISS-288).
import { WS_URL } from '@/lib/api/client';

interface Envelope {
  event: string;
  // biome-ignore lint/suspicious/noExplicitAny: server-side event payloads are heterogeneous
  data: any;
  timestamp: string;
}

type Listener = (env: Envelope) => void;

/**
 * Singleton WebSocket wrapper. One connection per browser tab, shared
 * across hooks. Reconnects with jittered exponential backoff, resends
 * room subscriptions on every `onopen`, and fans out incoming messages
 * to registered listeners.
 *
 * Replay semantics: complete for job events (seq-gated via the job-events
 * REST endpoint) and best-effort for project events (refetch-on-reconnect
 * via broad React Query invalidation).
 */
class ForgeWebSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private rooms = new Set<string>();
  private retry = 0;
  private readonly BASE_DELAY = 1000;
  private readonly MAX_DELAY = 30_000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private onOpenCallbacks = new Set<() => void>();
  private explicitlyClosed = false;
  private bearerToken: string | undefined;

  /**
   * Optionally set a bearer token to authenticate via the
   * `forge.bearer.<jwt>` Sec-WebSocket-Protocol subprotocol (ISS-286). Web
   * normally relies on the same-origin `forge_auth` cookie and leaves this
   * unset; cross-origin embeds (widget, future Tauri-style hosts) call this
   * before `connect()` so the JWT never appears in the URL / access logs.
   */
  setBearerToken(token: string | undefined): void {
    this.bearerToken = token;
  }

  connect(): void {
    if (typeof window === 'undefined') return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.explicitlyClosed = false;
    const ws = this.bearerToken
      ? new WebSocket(WS_URL, [`forge.bearer.${this.bearerToken}`])
      : new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      for (const room of this.rooms) {
        ws.send(JSON.stringify({ type: 'subscribe', room }));
      }
      for (const cb of this.onOpenCallbacks) {
        try {
          cb();
        } catch {
          // keep the rest of the callbacks running
        }
      }
    };

    ws.onmessage = (e) => {
      try {
        const env = JSON.parse(e.data) as Envelope;
        for (const listener of this.listeners) {
          try {
            listener(env);
          } catch {
            // swallow — a faulty listener should not break dispatch
          }
        }
      } catch {
        // ignore non-JSON frames
      }
    };

    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.ws = null;
      if (this.explicitlyClosed) return;
      const base = Math.min(this.BASE_DELAY * 2 ** this.retry, this.MAX_DELAY);
      const jitter = 0.8 + Math.random() * 0.4;
      const delay = Math.floor(base * jitter);
      this.retry++;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  subscribe(room: string): void {
    this.rooms.add(room);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', room }));
    }
  }

  unsubscribe(room: string): void {
    this.rooms.delete(room);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', room }));
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onOpen(cb: () => void): () => void {
    this.onOpenCallbacks.add(cb);
    return () => {
      this.onOpenCallbacks.delete(cb);
    };
  }

  disconnect(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.rooms.clear();
    this.listeners.clear();
  }
}

export const wsClient = new ForgeWebSocket();
