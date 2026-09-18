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
import {
  extractMessageImages,
  extractMessageText,
  type RocketChatImageRef,
} from './rest-client.js';

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
  /** Parent thread message id when the message was posted inside a thread. */
  tmid?: string | undefined;
  /** Images uploaded with the message, as absolute credentialed refs. */
  images: RocketChatImageRef[];
  /**
   * What this message replies to: the quoted message's id where it quotes one,
   * else the thread parent, else undefined (ISS-1087).
   */
  replyToId?: string | undefined;
}

// cm:guard the QUOTE wins over the thread parent: a message inside a thread that quotes a specific message is answering that one, and the thread root is where it was said. Rocket.Chat carries a quote only as a `?msg=<id>` link, in `attachments[].message_link` and again in the text, so both are read (ISS-1087 criteria 9-11).
const QUOTE_LINK_RE = /\?msg=([A-Za-z0-9]+)/;
export function replyTargetOf(m: {
  msg?: unknown;
  tmid?: unknown;
  attachments?: unknown;
}): string | undefined {
  const attachments = Array.isArray(m.attachments) ? m.attachments : [];
  for (const a of attachments) {
    const link = (a as { message_link?: unknown })?.message_link;
    const hit = typeof link === 'string' ? QUOTE_LINK_RE.exec(link) : null;
    if (hit) return hit[1];
  }
  const inText = typeof m.msg === 'string' ? QUOTE_LINK_RE.exec(m.msg) : null;
  if (inText) return inText[1];
  return typeof m.tmid === 'string' ? m.tmid : undefined;
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
export function parseStreamMessage(arg: unknown, serverUrl = ''): RocketChatIncomingMessage | null {
  if (!arg || typeof arg !== 'object') return null;
  const m = arg as Record<string, unknown>;
  const rid = m.rid;
  const u = m.u as { _id?: string; username?: string } | undefined;
  if (typeof rid !== 'string' || typeof m._id !== 'string' || !u?._id) return null;
  return {
    id: m._id,
    rid,
    // cm:why attachment text is included: a reply-quote's quoted content, and a webhook bot's entire body, live in `attachments` rather than in `msg`, so reading `msg` alone loses the whole message for a webhook post.
    text: extractMessageText(m as Parameters<typeof extractMessageText>[0], serverUrl),
    userId: u._id,
    username: u.username,
    ts: typeof m.ts === 'string' ? m.ts : undefined,
    isSystem: typeof m.t === 'string' && m.t.length > 0,
    isEdited: m.editedAt != null,
    tmid: typeof m.tmid === 'string' ? m.tmid : undefined,
    images: extractMessageImages(m as Parameters<typeof extractMessageImages>[0], serverUrl),
    replyToId: replyTargetOf(m),
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
/** A `sendMessage` whose RC ack never arrives must not hang its caller (and
 *  leak a `pending` entry) forever — the socket may be half-open. */
const SEND_TIMEOUT_MS = 15_000;

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
        this.setState('live');
        this.connectResolve?.();
        this.connectResolve = undefined;
        this.connectReject = undefined;
        return;
      case 'nosub':
        if (frame.id !== this.subId) return;
        if (this.state === 'live') {
          // cm:guard a `nosub` after the subscription went live must CLOSE the socket, never be a no-op: the socket stays open and server pings keep flowing, so the watchdog never fires while no room message arrives again — the bot goes silently deaf ("replies once then goes quiet").
          this.opts.onError?.(
            new Error(`DDP subscription lost (nosub): ${JSON.stringify(frame.error)}`),
          );
          this.close();
        } else {
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
    this.setState('authenticated');
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
      const m = parseStreamMessage(arg, this.opts.serverUrl);
      if (m) this.opts.onMessage(m);
    }
  }

  /** Post a message to a room (optionally inside a thread). Resolves on RC ack with the message id. */
  // cm:guard the resolved id is the `_id` sent in `params`, and RC's ack is what makes it a receipt rather than a guess: a caller that stores it as a thread id before the ack would register a thread the server never accepted (ISS-978 criterion 7).
  sendMessage(rid: string, text: string, tmid?: string): Promise<string> {
    const id = this.nextId();
    const messageId = randomUUID().replace(/-/g, '');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('sendMessage ack timed out'));
      }, SEND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve(messageId);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({
        msg: 'method',
        method: 'sendMessage',
        id,
        params: [{ _id: messageId, rid, msg: text, ...(tmid ? { tmid } : {}) }],
      });
    });
  }

  /**
   * Tell the room the bot is typing, or that it stopped.
   */
  // cm:guard the ONE write `stream-notify-room` accepts from a client is `<rid>/user-activity`, and the server checks `shownName` against the name it shows for this account — the username, or the display name under `UI_Use_Real_Name` — so a mismatch is an error frame and the caller's to retry under the other name. `['user-typing']` starts and `[]` stops; the client forgets an activity it has not heard about for 15 seconds, so a caller that wants it kept renews (ISS-1088 criterion 24).
  notifyUserActivity(rid: string, shownName: string, on: boolean): Promise<void> {
    return this.call('stream-notify-room', [
      `${rid}/user-activity`,
      shownName,
      on ? ['user-typing'] : [],
      {},
    ]).then(() => undefined);
  }

  /** One DDP method call: resolves on the server's result, rejects on its error frame or the send timeout. */
  private call(method: string, params: unknown[]): Promise<unknown> {
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} ack timed out`));
      }, SEND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ msg: 'method', method, id, params });
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
