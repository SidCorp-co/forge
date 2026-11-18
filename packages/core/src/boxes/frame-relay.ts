// A browser box's view (ISS-1276, ISS-1315). agent-browser's stream socket also takes input, so core
// is its WebSocket client over a tunnel stream and forwards only its frames to one viewer, at most
// `fps` a second. agent-browser sends a joining client its newest frame at once, so a static page
// shows its picture; then each changed one.
//
// A stream that cannot be read is said by name, never left silent: the stream is opened again (the
// runner reads agent-browser's port afresh for each, so a daemon that restarted onto a new port is
// found), and after `reopenTries` failures in a row, or no frame within `firstFrameMs`, the viewer
// is closed with the fault's code and why.

import type { Duplex } from 'node:stream';
import type { BoxViewFault } from '@forge/contracts/box-wire';
import { WebSocket } from 'ws';
import { logger } from '../lib/logger.js';
import { streamEndOf } from '../previews/index.js';

export const FRAME_RELAY = {
  /** A stream that sends no frame this long after it opens is said silent. */
  firstFrameMs: 10_000,
  /** A static page sends nothing for minutes: a ping keeps the tunnel stream from idling out. */
  pingMs: 60_000,
  reopenTries: 3,
  reopenDelayMs: 1_000,
};
export type FrameRelayLimits = typeof FRAME_RELAY;

export type OpenView = () => Promise<{ ok: true; stream: Duplex } | { ok: false; why: string }>;

/** The viewer's half: its frames, the named fault that ends it, and its own close. */
export interface FrameViewer {
  frame(text: string): void;
  fail(code: BoxViewFault, why: string): void;
  onClose(fn: () => void): void;
}

/**
 * agent-browser's `frame` message as a viewer gets it, or null for anything else (`status`, `tabs`,
 * `url`, `console`). agent-browser 0.43 builds its messages with serde_json's sorted keys, so `type`
 * comes last: a message is read, never matched by its first bytes.
 */
export function viewerFrameOf(text: string): string | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (m === null || typeof m !== 'object') return null;
  const { type, seq, data } = m as Record<string, unknown>;
  if (type !== 'frame' || typeof data !== 'string' || data.length === 0) return null;
  return JSON.stringify({ type: 'frame', seq: typeof seq === 'number' ? seq : null, data });
}

/** Why a stream to agent-browser ended, in words a person and the log both read. */
function whyEnded(err: unknown): string {
  const code = streamEndOf(err);
  if (code === 'CONNECT_REFUSED') {
    return 'the device could not reach agent-browser’s stream port (CONNECT_REFUSED; its runner log names the port)';
  }
  if (code) return `the box’s stream ended (${code})`;
  const said = err instanceof Error ? err.message : String(err);
  return `agent-browser’s stream could not be read: ${said}`;
}

export function relayFrames(
  boxId: string,
  viewer: FrameViewer,
  first: Duplex,
  reopen: OpenView,
  fps: number,
  limits: FrameRelayLimits = FRAME_RELAY,
): void {
  const every = 1000 / fps;
  let gone = false;
  let failures = 0;
  let pending: string | null = null;
  let lastSent = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let upstream: WebSocket | null = null;

  const flush = () => {
    flushTimer = null;
    if (pending === null || gone) return;
    viewer.frame(pending);
    pending = null;
    lastSent = Date.now();
  };
  const take = (frame: string) => {
    pending = frame;
    const wait = lastSent + every - Date.now();
    if (wait <= 0) flush();
    else flushTimer ??= setTimeout(flush, wait);
  };
  const fail = (code: BoxViewFault, why: string) => {
    if (gone) return;
    gone = true;
    logger.warn({ boxId, code, why }, 'box viewer: agent-browser’s stream');
    viewer.fail(code, why);
  };
  const retry = (why: string) => {
    if (gone) return;
    failures++;
    logger.warn(
      { boxId, why, failures },
      'box viewer: agent-browser’s stream ended; opening it again',
    );
    if (failures > limits.reopenTries) {
      fail('STREAM_UNREADABLE', `${why}, ${failures} times in a row`);
      return;
    }
    setTimeout(async () => {
      if (gone) return;
      const opened = await reopen();
      if (gone) {
        if (opened.ok) opened.stream.destroy();
        return;
      }
      if (opened.ok) attach(opened.stream);
      else retry(`the box’s device cannot be reached (${opened.why})`);
    }, limits.reopenDelayMs).unref();
  };

  const attach = (stream: Duplex) => {
    let why = 'agent-browser’s stream closed';
    let framed = false;
    stream.on('error', (err) => {
      why = whyEnded(err);
    });
    const ws = new WebSocket(`ws://127.0.0.1/?maxFps=${fps}`, {
      createConnection: () => stream as never,
    });
    upstream = ws;
    const silent = setTimeout(() => {
      if (!framed) {
        fail(
          'STREAM_SILENT',
          `agent-browser’s stream sent no frame in ${limits.firstFrameMs / 1000} s`,
        );
        ws.terminate();
      }
    }, limits.firstFrameMs);
    silent.unref();
    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, limits.pingMs);
    ping.unref();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = viewerFrameOf(data.toString());
      if (frame === null) return;
      framed = true;
      failures = 0;
      take(frame);
    });
    ws.on('error', (err) => {
      why = whyEnded(err);
    });
    ws.on('close', () => {
      clearTimeout(silent);
      clearInterval(ping);
      if (upstream === ws) upstream = null;
      retry(why);
    });
  };

  viewer.onClose(() => {
    gone = true;
    if (flushTimer) clearTimeout(flushTimer);
    upstream?.terminate();
  });
  attach(first);
}
