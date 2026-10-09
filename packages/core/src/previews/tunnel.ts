// Core's half of the preview tunnel (BC-2, BC-5; `@forge/contracts/preview-tunnel`): each box that
// holds a live preview dials `/ws/preview-tunnel`, and core opens one stream over it per browser
// connection. A stream is a Node Duplex, so `http.request({ createConnection })` parses the HTTP and
// the `101` upgrade over it (relay.ts) and the box only copies bytes. Credit is yamux's: a sender
// stops at zero window, a receiver grants back what its reader consumed. One process holds every
// tunnel in memory, as rooms are (`lib/rooms.ts`).

import type { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_LIMITS,
  type TunnelFrame,
  type TunnelResetCode,
} from '@forge/contracts/preview-tunnel';
import { type WebSocket, WebSocketServer } from 'ws';
import { logger } from '../lib/logger.js';

type StreamEnd = TunnelResetCode | 'TUNNEL_DOWN';

/** A stream ended early: a plain Error whose `cause` is the box's reset code or `TUNNEL_DOWN`. */
const streamEnded = (code: StreamEnd) =>
  new Error(`preview tunnel stream ${code}`, { cause: code });

/** Why `err` ended a stream, where a tunnel stream ended it; null for any other error. */
export function streamEndOf(err: unknown): StreamEnd | null {
  if (!(err instanceof Error) || typeof err.cause !== 'string') return null;
  return err.message === `preview tunnel stream ${err.cause}` ? (err.cause as StreamEnd) : null;
}

export class TunnelStream extends Duplex {
  private sendWindow: number = TUNNEL_LIMITS.initialWindow;
  private recvAllowance: number = TUNNEL_LIMITS.initialWindow;
  private unacked = 0;
  private wake: (() => void) | null = null;
  private idle: NodeJS.Timeout | null = null;
  private remoteEnded = false;
  private finished = false;
  /** Set once the stream is torn down by a reset, either side's: nothing more is sent for it. */
  gone = false;

  constructor(
    private readonly tunnel: Tunnel,
    readonly id: number,
    readonly previewId: string,
  ) {
    super({ allowHalfOpen: true });
    this.touch();
    this.once('finish', () => {
      this.finished = true;
    });
  }

  /** The browser-facing bytes, sent as data frames within the window the box granted. */
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (e?: Error | null) => void) {
    this.sendAll(chunk).then(() => done(), done);
  }

  override _final(done: (e?: Error | null) => void) {
    if (!this.gone) this.tunnel.send({ type: 'close', streamId: this.id });
    done();
  }

  override _read() {
    this.grant();
  }

  override _destroy(err: Error | null, done: (e: Error | null) => void) {
    if (!this.gone && !(this.remoteEnded && this.finished)) {
      this.gone = true;
      this.tunnel.send({ type: 'reset', streamId: this.id, code: 'CANCELLED' });
    }
    this.gone = true;
    if (this.idle) clearTimeout(this.idle);
    this.wake?.();
    this.tunnel.forget(this);
    done(err);
  }

  /** Every `connect` a Node client makes of its socket is a no-op here: the stream is open. */
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  setTimeout() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }

  private async sendAll(chunk: Buffer): Promise<void> {
    let at = 0;
    while (at < chunk.byteLength) {
      if (this.gone) throw streamEnded('CANCELLED');
      if (this.sendWindow === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
        continue;
      }
      const n = Math.min(chunk.byteLength - at, this.sendWindow, TUNNEL_LIMITS.maxDataBytes);
      this.tunnel.send({ type: 'data', streamId: this.id, bytes: chunk.subarray(at, at + n) });
      this.sendWindow -= n;
      at += n;
      this.touch();
      await this.tunnel.drained();
    }
  }

  private grant(): void {
    if (this.gone || this.unacked < TUNNEL_LIMITS.windowUpdateAt) return;
    this.tunnel.send({ type: 'window', streamId: this.id, delta: this.unacked });
    this.recvAllowance += this.unacked;
    this.unacked = 0;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.resetWith('IDLE'), TUNNEL_LIMITS.streamIdleSeconds * 1000);
    this.idle.unref();
  }

  /** Tear the stream down and tell the box why. */
  resetWith(code: TunnelResetCode): void {
    if (this.gone) return;
    this.gone = true;
    this.tunnel.send({ type: 'reset', streamId: this.id, code });
    this.destroy(streamEnded(code));
  }

  /** A frame the box sent for this stream. */
  receive(frame: TunnelFrame): void {
    this.touch();
    switch (frame.type) {
      case 'data':
        this.recvAllowance -= frame.bytes.byteLength;
        if (this.recvAllowance < 0) {
          this.resetWith('WINDOW_EXCEEDED');
          return;
        }
        this.unacked += frame.bytes.byteLength;
        if (this.push(Buffer.from(frame.bytes))) this.grant();
        return;
      case 'window':
        this.sendWindow += frame.delta;
        this.wake?.();
        return;
      case 'close':
        this.remoteEnded = true;
        this.push(null);
        return;
      case 'reset':
        this.gone = true;
        this.destroy(streamEnded(frame.code));
        return;
      case 'open':
        this.resetWith('PROTOCOL');
        return;
    }
  }
}

const DRAIN_POLL_MS = 10;

/** Why a request got no stream: the box is away, the queue for one was full, or it waited too long. */
export type StreamRefusal = 'TUNNEL_DOWN' | 'QUEUE_FULL' | 'WAIT_TIMEOUT' | 'ABORTED';

/** A browser request parked until its preview has a free stream. */
interface Waiter {
  previewId: string;
  resolve: (open: StreamOpen) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: () => void;
}

export class Tunnel {
  private readonly streams = new Map<number, TunnelStream>();
  private nextId = 1;
  /** Requests waiting for a stream, oldest first. */
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly deviceId: string,
    private readonly ws: WebSocket,
  ) {}

  get size(): number {
    return this.streams.size;
  }

  streamsOf(previewId: string): number {
    let n = 0;
    for (const s of this.streams.values()) if (s.previewId === previewId) n++;
    return n;
  }

  /** Requests parked for a stream to `previewId`. */
  waitingOf(previewId: string): number {
    let n = 0;
    for (const w of this.waiters) if (w.previewId === previewId) n++;
    return n;
  }

  private hasRoom(previewId: string): boolean {
    return (
      this.streams.size < TUNNEL_LIMITS.maxStreamsPerTunnel &&
      this.streamsOf(previewId) < TUNNEL_LIMITS.maxStreamsPerPreview
    );
  }

  /**
   * A stream to `previewId` now if it has room, else once one is released: a browser opening many
   * requests at once is served in turn, not refused. A request that waits past
   * `streamWaitSeconds`, or finds `maxQueuedPerPreview` already waiting, is refused by name; an
   * aborted `signal` takes it out of the queue.
   */
  acquire(previewId: string, signal?: AbortSignal): Promise<StreamOpen> {
    if (signal?.aborted) return Promise.resolve({ ok: false, why: 'ABORTED' });
    if (this.waiters.length === 0 && this.hasRoom(previewId)) {
      return Promise.resolve({ ok: true, stream: this.open(previewId) });
    }
    if (this.waitingOf(previewId) >= TUNNEL_LIMITS.maxQueuedPerPreview) {
      return Promise.resolve({ ok: false, why: 'QUEUE_FULL' });
    }
    return new Promise((resolve) => {
      const leave = (open: StreamOpen) => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.onAbort);
        resolve(open);
      };
      const waiter: Waiter = {
        previewId,
        resolve,
        timer: setTimeout(
          () => leave({ ok: false, why: 'WAIT_TIMEOUT' }),
          TUNNEL_LIMITS.streamWaitSeconds * 1000,
        ),
        signal,
        onAbort: () => leave({ ok: false, why: 'ABORTED' }),
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Give each waiter, oldest first, the stream it waited for, where its preview has room now. */
  private pump(): void {
    for (let i = 0; i < this.waiters.length; ) {
      if (this.streams.size >= TUNNEL_LIMITS.maxStreamsPerTunnel) return;
      const waiter = this.waiters[i] as Waiter;
      if (!this.hasRoom(waiter.previewId)) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.resolve({ ok: true, stream: this.open(waiter.previewId) });
    }
  }

  private refuseAll(why: StreamRefusal): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.resolve({ ok: false, why });
    }
  }

  private open(previewId: string): TunnelStream {
    const id = this.nextId++;
    const stream = new TunnelStream(this, id, previewId);
    this.streams.set(id, stream);
    this.send({ type: 'open', streamId: id, previewId });
    return stream;
  }

  send(frame: TunnelFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(encodeTunnelFrame(frame), { binary: true });
  }

  /** Resolves once the socket's queue is under the high-water mark: browsers wait, the box does not. */
  async drained(): Promise<void> {
    while (
      this.ws.readyState === this.ws.OPEN &&
      this.ws.bufferedAmount > TUNNEL_LIMITS.socketHighWater
    ) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  }

  forget(stream: TunnelStream): void {
    if (this.streams.get(stream.id) === stream) {
      this.streams.delete(stream.id);
      this.pump();
    }
  }

  /** One binary message from the box. A fault naming a stream resets it; one naming none is dropped. */
  receive(message: Uint8Array): void {
    const decoded = decodeTunnelFrame(message);
    if (!decoded.ok) {
      logger.warn({ deviceId: this.deviceId, detail: decoded.detail }, 'preview tunnel: bad frame');
      const named = decoded.streamId === null ? undefined : this.streams.get(decoded.streamId);
      named?.resetWith('PROTOCOL');
      return;
    }
    const stream = this.streams.get(decoded.frame.streamId);
    if (!stream) {
      // A stream core never opened or already forgot: say so once, unless the box is ending it.
      if (decoded.frame.type !== 'reset') {
        this.send({ type: 'reset', streamId: decoded.frame.streamId, code: 'PROTOCOL' });
      }
      return;
    }
    stream.receive(decoded.frame);
  }

  /** The socket went away: every stream on it ends with it. */
  dropAll(): void {
    this.refuseAll('TUNNEL_DOWN');
    for (const stream of [...this.streams.values()]) {
      stream.gone = true;
      stream.destroy(streamEnded('TUNNEL_DOWN'));
    }
    this.streams.clear();
  }

  close(code: number, reason: string): void {
    this.dropAll();
    this.ws.close(code, reason);
  }
}

const tunnels = new Map<string, Tunnel>();
/** When each box's tunnel last went away, kept until it returns. */
const lostAt = new Map<string, number>();
/** When each box's tunnel last came up. */
const upAt = new Map<string, number>();

/** A box's tunnel socket is up: it replaces any older one the box held. */
export function adoptTunnel(deviceId: string, ws: WebSocket, now = Date.now()): Tunnel {
  tunnels.get(deviceId)?.close(1000, 'replaced by a newer tunnel from the same box');
  const tunnel = new Tunnel(deviceId, ws);
  tunnels.set(deviceId, tunnel);
  lostAt.delete(deviceId);
  upAt.set(deviceId, now);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      ws.close(1003, 'the preview tunnel carries binary frames only');
      return;
    }
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    tunnel.receive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  });
  ws.on('close', () => {
    tunnel.dropAll();
    if (tunnels.get(deviceId) === tunnel) {
      tunnels.delete(deviceId);
      lostAt.set(deviceId, Date.now());
    }
  });
  return tunnel;
}

export type StreamOpen = { ok: true; stream: TunnelStream } | { ok: false; why: StreamRefusal };

/** A new stream to `previewId`'s dev server over its box's tunnel, waiting its turn when it is full. */
export function openTunnelStream(
  deviceId: string,
  previewId: string,
  signal?: AbortSignal,
): Promise<StreamOpen> {
  const tunnel = tunnels.get(deviceId);
  if (!tunnel) return Promise.resolve({ ok: false, why: 'TUNNEL_DOWN' });
  return tunnel.acquire(previewId, signal);
}

/** The streams open to a preview's dev server, and the requests waiting for one. */
export function streamCountsOf(
  deviceId: string,
  previewId: string,
): { streams: number; waiting: number } {
  const tunnel = tunnels.get(deviceId);
  return tunnel
    ? { streams: tunnel.streamsOf(previewId), waiting: tunnel.waitingOf(previewId) }
    : { streams: 0, waiting: 0 };
}

/** Whether a box's tunnel is up, and since when it is down or up. */
export function tunnelStatus(deviceId: string): {
  up: boolean;
  upAt: number | null;
  lostAt: number | null;
} {
  return {
    up: tunnels.has(deviceId),
    upAt: upAt.get(deviceId) ?? null,
    lostAt: lostAt.get(deviceId) ?? null,
  };
}

/** A frame and its header: a data frame at its largest is the most one message carries. */
const MAX_MESSAGE = TUNNEL_LIMITS.maxDataBytes + 12;
const PING_MS = 25_000;

let server: WebSocketServer | null = null;
let pinger: NodeJS.Timeout | null = null;
const alive = new WeakMap<WebSocket, boolean>();

/**
 * The upgrade of `/ws/preview-tunnel` from a box the WebSocket door already authenticated by its
 * device credential (`ws/server.ts`): the socket becomes that box's tunnel.
 */
export function acceptTunnelUpgrade(
  deviceId: string,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  server ??= new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  if (pinger === null) {
    pinger = setInterval(() => {
      for (const ws of server?.clients ?? []) {
        if (alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }, PING_MS);
    pinger.unref();
  }
  server.handleUpgrade(req, socket, head, (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('error', (err) => logger.warn({ err, deviceId }, 'preview tunnel: socket error'));
    adoptTunnel(deviceId, ws);
  });
}

/** Every tunnel closed: the process is winding down. */
export function closeAllTunnels(): void {
  for (const tunnel of tunnels.values()) tunnel.close(1001, 'server shutting down');
  tunnels.clear();
  if (pinger) clearInterval(pinger);
  pinger = null;
  server?.close();
  server = null;
}
