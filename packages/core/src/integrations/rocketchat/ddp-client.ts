/**
 * ISS-604 (P2c) — minimal Rocket.Chat DDP (Realtime API) client over `ws`.
 *
 * DDP is JSON-over-WebSocket. We speak just enough of it for a bot:
 *   connect handshake → method `login {resume}` → sub `stream-room-messages`
 *   for `__my_messages__` (every room the bot is in) → receive `changed`
 *   frames → method `sendMessage`. Server `ping` is answered with `pong`.
 *
 * Deliberately dependency-light (no `@rocket.chat/sdk`) and reconnect-free —
 * the connection-manager (single-owner via pg advisory lock) owns lifecycle,
 * backoff, and re-`connect()` on close.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { extractMessageText } from './rest-client.js';

export interface RocketChatIncomingMessage {
  id: string;
  rid: string;
  text: string;
  userId: string;
  username?: string | undefined;
  ts?: string | undefined;
  /** RC system message (join/leave/etc.) — has a `t` type. */
  isSystem: boolean;
  /** An edit of an existing message, not a new one. */
  isEdited: boolean;
  /** User ids @-mentioned in the message — used for bot mention-gating. */
  mentions: string[];
  /** Parent thread message id when the message was posted inside a thread. */
  tmid?: string | undefined;
}

export type DdpClientState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'authenticated'
  | 'live'
  | 'closed';

/** The subset of the `ws` WebSocket surface we use — lets tests inject a fake. */
export interface WsLike {
  on(event: 'open' | 'message' | 'close' | 'error', cb: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
}

export interface RocketChatDdpOptions {
  /** e.g. https://chat.sidcorp.co (ws(s):// + /websocket derived). */
  serverUrl: string;
  authToken: string;
  userId: string;
  onMessage: (m: RocketChatIncomingMessage) => void;
  onState?: (s: DdpClientState) => void;
  onClose?: (info: { code?: number | undefined; reason?: string | undefined }) => void;
  onError?: (e: Error) => void;
  /** Test seam. */
  wsFactory?: (url: string) => WsLike;
}

/** Convert an https/http server URL to the DDP websocket endpoint. */
export function ddpUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/websocket`;
}

/** Map a raw `stream-room-messages` arg to our shape, or null if unusable. */
export function parseStreamMessage(arg: unknown): RocketChatIncomingMessage | null {
  if (!arg || typeof arg !== 'object') return null;
  const m = arg as Record<string, unknown>;
  const rid = m.rid;
  const u = m.u as { _id?: string; username?: string } | undefined;
  if (typeof rid !== 'string' || typeof m._id !== 'string' || !u?._id) return null;
  const mentions = Array.isArray(m.mentions)
    ? (m.mentions as Array<{ _id?: string }>).map((x) => x?._id).filter((x): x is string => !!x)
    : [];
  return {
    id: m._id,
    rid,
    // Includes attachment text — a reply-quote's quoted content (and a webhook
    // bot's entire body) lives in attachments, not msg.
    text: extractMessageText(m as Parameters<typeof extractMessageText>[0]),
    userId: u._id,
    username: u.username,
    ts: typeof m.ts === 'string' ? m.ts : undefined,
    isSystem: typeof m.t === 'string' && m.t.length > 0,
    isEdited: m.editedAt != null,
    mentions,
    tmid: typeof m.tmid === 'string' ? m.tmid : undefined,
  };
}

/**
 * Liveness watchdog. RC's DDP server pings periodically, so a healthy link is
 * never silent for long — but a half-open TCP connection (server died without
 * FIN) stays "live" forever and the bot goes silently deaf. After a quiet
 * spell we nudge with a client ping (server must pong); if NOTHING arrives for
 * DEAD_AFTER_MS we close, which hands lifecycle back to the connection-manager
 * (its onClose schedules the redial).
 */
const WATCHDOG_INTERVAL_MS = 30_000;
const QUIET_PING_AFTER_MS = 60_000;
const DEAD_AFTER_MS = 150_000;

interface DdpFrame {
  msg?: string;
  id?: string;
  collection?: string;
  fields?: { eventName?: string; args?: unknown[] };
  result?: unknown;
  error?: unknown;
  server_id?: unknown;
}

export class RocketChatDdpClient {
  private ws?: WsLike;
  private state: DdpClientState = 'idle';
  private idCounter = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private connectResolve?: (() => void) | undefined;
  private connectReject?: ((e: Error) => void) | undefined;
  private loginId?: string | undefined;
  private subId?: string | undefined;
  private lastFrameAt = 0;
  private watchdog?: NodeJS.Timeout | undefined;

  constructor(private readonly opts: RocketChatDdpOptions) {}

  getState(): DdpClientState {
    return this.state;
  }

  private setState(s: DdpClientState): void {
    this.state = s;
    this.opts.onState?.(s);
  }

  private nextId(): string {
    this.idCounter += 1;
    return String(this.idCounter);
  }

  private send(frame: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(frame));
  }

  /** Connect + login + subscribe. Resolves once the subscription is `ready`. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.setState('connecting');
      const factory =
        this.opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
      try {
        this.ws = factory(ddpUrl(this.opts.serverUrl));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws.on('open', () => {
        this.lastFrameAt = Date.now();
        this.startWatchdog();
        this.send({ msg: 'connect', version: '1', support: ['1'] });
      });
      this.ws.on('message', (data: unknown) => this.onRaw(String(data)));
      this.ws.on('error', (err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        this.opts.onError?.(e);
        this.connectReject?.(e);
        this.connectReject = undefined;
      });
      this.ws.on('close', (code: unknown, reason: unknown) => {
        this.stopWatchdog();
        this.setState('closed');
        for (const p of this.pending.values()) p.reject(new Error('connection closed'));
        this.pending.clear();
        this.opts.onClose?.({
          code: typeof code === 'number' ? code : undefined,
          reason: String(reason ?? ''),
        });
        this.connectReject?.(new Error('closed before ready'));
        this.connectReject = undefined;
      });
    });
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      const idle = Date.now() - this.lastFrameAt;
      if (idle >= DEAD_AFTER_MS) {
        this.opts.onError?.(new Error(`DDP link silent for ${idle}ms; closing as dead`));
        this.close();
      } else if (idle >= QUIET_PING_AFTER_MS) {
        this.send({ msg: 'ping' });
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private onRaw(raw: string): void {
    this.lastFrameAt = Date.now();
    let frame: DdpFrame;
    try {
      frame = JSON.parse(raw) as DdpFrame;
    } catch {
      return;
    }
    switch (frame.msg) {
      case 'ping':
        this.send(frame.id ? { msg: 'pong', id: frame.id } : { msg: 'pong' });
        return;
      case 'connected':
        this.setState('connected');
        this.login();
        return;
      case 'failed':
        this.connectReject?.(new Error('DDP version negotiation failed'));
        this.connectReject = undefined;
        return;
      case 'result':
        this.onResult(frame);
        return;
      case 'ready':
        // Our single subscription is live.
        this.setState('live');
        this.connectResolve?.();
        this.connectResolve = undefined;
        return;
      case 'nosub':
        if (frame.id === this.subId) {
          this.connectReject?.(new Error(`subscription rejected: ${JSON.stringify(frame.error)}`));
          this.connectReject = undefined;
        }
        return;
      case 'changed':
        this.onChanged(frame);
        return;
      default:
        return;
    }
  }

  private login(): void {
    this.setState('authenticated'); // provisional; flips to live on sub ready
    this.loginId = this.nextId();
    this.send({
      msg: 'method',
      method: 'login',
      id: this.loginId,
      params: [{ resume: this.opts.authToken }],
    });
  }

  private subscribe(): void {
    this.subId = this.nextId();
    this.send({
      msg: 'sub',
      id: this.subId,
      name: 'stream-room-messages',
      params: ['__my_messages__', false],
    });
  }

  private onResult(frame: DdpFrame): void {
    if (frame.id === this.loginId) {
      if (frame.error) {
        this.connectReject?.(new Error(`login failed: ${JSON.stringify(frame.error)}`));
        this.connectReject = undefined;
        return;
      }
      this.subscribe();
      return;
    }
    const p = frame.id ? this.pending.get(frame.id) : undefined;
    if (p && frame.id) {
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new Error(JSON.stringify(frame.error)));
      else p.resolve(frame.result);
    }
  }

  private onChanged(frame: DdpFrame): void {
    if (frame.collection !== 'stream-room-messages') return;
    for (const arg of frame.fields?.args ?? []) {
      const m = parseStreamMessage(arg);
      if (m) this.opts.onMessage(m);
    }
  }

  /** Post a message to a room (optionally inside a thread). Resolves on RC ack. */
  sendMessage(rid: string, text: string, tmid?: string): Promise<unknown> {
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({
        msg: 'method',
        method: 'sendMessage',
        id,
        params: [
          { _id: randomUUID().replace(/-/g, ''), rid, msg: text, ...(tmid ? { tmid } : {}) },
        ],
      });
    });
  }

  close(): void {
    this.stopWatchdog();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.setState('closed');
  }
}
