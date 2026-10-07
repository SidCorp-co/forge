'use client';

import type { WsFrame } from '@forge/contracts/ws-frames';
import { WS_URL } from '@/lib/api/client';

type Listener = (env: WsFrame) => void;

export interface SocketOpen {
  first: boolean;
  openedAt: number;
}

/** A room some reader holds open, and when the earliest of them started reading what it covers. */
interface RoomWant {
  count: number;
  since: number;
}

/** How long a subscribe that asked for a replay waits for the server to say it is done. */
export const REPLAY_WAIT_MS = 5_000;
/** Gaps reported this close together (every room of one reconnect) cost one broad refetch. */
const GAP_COALESCE_MS = 100;

/**
 * Singleton WebSocket wrapper. One connection per browser tab, shared
 * across hooks. Reconnects with jittered exponential backoff, resends
 * room subscriptions on every `onopen`, and fans out incoming messages
 * to registered listeners.
 *
 * Replay: every subscribe asks the server for the frames its room published since its readers
 * started reading (`since`, on `performance.now()`'s clock) or, after a drop, since the socket
 * closed. The server sends them ahead of `replay.done`, so the event router invalidates exactly
 * what changed while the page was not listening. Where the server cannot vouch for the whole span
 * (`complete: false`, a refused room aside) or does not answer, the gap listeners refetch broadly.
 */
class ForgeWebSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private rooms = new Map<string, RoomWant>();
  private retry = 0;
  private readonly BASE_DELAY = 1000;
  private readonly MAX_DELAY = 30_000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private onOpenCallbacks = new Set<(open: SocketOpen) => void>();
  private gapCallbacks = new Set<() => void>();
  private awaitingReplay = new Map<string, ReturnType<typeof setTimeout>>();
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private closedAt: number | null = null;
  private hasOpened = false;
  private explicitlyClosed = false;
  private bearerToken: string | undefined;

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
      const open: SocketOpen = { first: !this.hasOpened, openedAt: Date.now() };
      this.hasOpened = true;
      const now = performance.now();
      for (const [room, want] of this.rooms) {
        const from = this.closedAt === null ? want.since : Math.min(want.since, this.closedAt);
        this.sendSubscribe(room, now - from);
      }
      this.closedAt = null;
      for (const cb of this.onOpenCallbacks) {
        try {
          cb(open);
        } catch {
          // keep the rest of the callbacks running
        }
      }
    };

    ws.onmessage = (e) => {
      try {
        const env = JSON.parse(e.data) as WsFrame;
        if (env.event === 'replay.done' || env.event === 'subscribe.denied') {
          this.settleReplay(env.data.room, env.event === 'subscribe.denied' || env.data.complete);
        }
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
      this.closedAt ??= performance.now();
      for (const timer of this.awaitingReplay.values()) clearTimeout(timer);
      this.awaitingReplay.clear();
      if (this.explicitlyClosed) return;
      const base = Math.min(this.BASE_DELAY * 2 ** this.retry, this.MAX_DELAY);
      const jitter = 0.8 + Math.random() * 0.4;
      const delay = Math.floor(base * jitter);
      this.retry++;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  /**
   * Ref-counted: multiple independent callers (e.g. overlapping conversation
   * panes) can subscribe to the same room without one caller's unsubscribe
   * killing live updates for the others (ISS-689). `since` is when the caller
   * started reading what the room covers; the first caller's asks the replay.
   */
  subscribe(room: string, since: number = performance.now()): void {
    const want = this.rooms.get(room);
    if (want) {
      want.count++;
      return;
    }
    this.rooms.set(room, { count: 1, since });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(room, performance.now() - since);
    }
  }

  unsubscribe(room: string): void {
    const want = this.rooms.get(room);
    if (!want) return;
    want.count--;
    if (want.count > 0) return;
    this.rooms.delete(room);
    const timer = this.awaitingReplay.get(room);
    if (timer) clearTimeout(timer);
    this.awaitingReplay.delete(room);
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

  onOpen(cb: (open: SocketOpen) => void): () => void {
    this.onOpenCallbacks.add(cb);
    return () => {
      this.onOpenCallbacks.delete(cb);
    };
  }

  /** Called when a replay could not cover what the page missed: the caller refetches broadly instead. */
  onReplayGap(cb: () => void): () => void {
    this.gapCallbacks.add(cb);
    return () => {
      this.gapCallbacks.delete(cb);
    };
  }

  disconnect(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const timer of this.awaitingReplay.values()) clearTimeout(timer);
    this.awaitingReplay.clear();
    this.ws?.close();
    this.ws = null;
    this.rooms.clear();
    this.listeners.clear();
  }

  private sendSubscribe(room: string, ageMs: number): void {
    this.ws?.send(JSON.stringify({ type: 'subscribe', room, replayMs: Math.max(0, Math.round(ageMs)) }));
    const prior = this.awaitingReplay.get(room);
    if (prior) clearTimeout(prior);
    this.awaitingReplay.set(
      room,
      setTimeout(() => this.settleReplay(room, false), REPLAY_WAIT_MS),
    );
  }

  private settleReplay(room: string, complete: boolean): void {
    const timer = this.awaitingReplay.get(room);
    if (!timer) return;
    clearTimeout(timer);
    this.awaitingReplay.delete(room);
    if (complete || this.gapTimer) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      for (const cb of this.gapCallbacks) {
        try {
          cb();
        } catch {
          // keep the rest of the callbacks running
        }
      }
    }, GAP_COALESCE_MS);
  }
}

export const wsClient = new ForgeWebSocket();
