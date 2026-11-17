// A box's live view and its holder's input, through Forge (ISS-1276, ADR 0015). A person mints a
// one-minute ticket for one box and one channel; the page spends it once on `/ws/boxes/view` or
// `/ws/boxes/input`. Core opens one tunnel stream per socket to the box's device (the preview tunnel,
// no new port, no tailnet) and proxies it server-side:
// - view: watch-only, many viewers, each at its own rate. agent-browser's stream socket also takes
//   input, so for a browser box core is the WebSocket client and forwards only frames, at most
//   `fps` a second (`./frame-relay.ts`); scrcpy and VNC bytes are relayed as they come (the device
//   opened them view-only); an RFB viewer's binary messages go back to x11vnc for its handshake,
//   which `-viewonly` keeps watch-only.
// - input: the holder's `BoxInput` lines, each validated and recorded before it is forwarded; the
//   socket closes the moment the hold ends.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  BOX_VIEW_CODECS,
  type BoxViewCodec,
  type BoxViewerMessage,
  boxInputSchema,
  boxViewQuerySchema,
} from '@forge/contracts/box-wire';
import { BOX_LIMITS, type BoxRecord } from '@forge/contracts/boxes';
import { jwtVerify, SignJWT } from 'jose';
import { type WebSocket, WebSocketServer } from 'ws';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { openBoxStream } from '../previews/index.js';
import { accessFor, type BoxActor, refuse } from './access.js';
import { recordPersonInput } from './acts.js';
import { relayFrames } from './frame-relay.js';
import { boxById, holderOf } from './read.js';
import { rowOf } from './service.js';

const ALG = 'HS256';
const ISSUER = 'forge.box.ticket';
type Channel = 'view' | 'input';
interface Grant {
  boxId: string;
  userId: string;
  channel: Channel;
}

const key = () => new TextEncoder().encode(env.JWT_SECRET);
const spent = new Map<string, number>();

export async function mintBoxTicket(
  boxId: string,
  actor: BoxActor,
  channel: Channel,
  now = Date.now(),
): Promise<{ ticket: string; expiresAt: string; url: string }> {
  const row = await rowOf(boxId);
  if (row.projectId === null) throw refuse('BOX_NOT_FOUND', `no box ${boxId} is any project's`);
  await accessFor(row.projectId, actor, 'project.read', 'watch a box');
  if (row.state !== 'agent' && row.state !== 'person') {
    throw refuse('BOX_NOT_READY', `the box is ${row.state}: it can be watched once it runs`);
  }
  if (channel === 'input' && (row.state !== 'person' || row.heldBy !== actor.userId)) {
    throw refuse(
      'BOX_NOT_HELD',
      'input reaches a box only from the person holding it: take control first',
      '/channel',
    );
  }
  const expiresAt = new Date(now + BOX_LIMITS.ticketSeconds * 1000);
  const ticket = await new SignJWT({ bid: boxId, ch: channel })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(actor.userId)
    .setJti(randomUUID())
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());
  return {
    ticket,
    expiresAt: expiresAt.toISOString(),
    url: `/ws/boxes/${channel}?ticket=${encodeURIComponent(ticket)}`,
  };
}

/** The ticket's grant, once; a second presentation, an expired one or a forged one answers null. */
export async function spendBoxTicket(token: string, now = Date.now()): Promise<Grant | null> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      algorithms: [ALG],
      currentDate: new Date(now),
    });
    const { bid, ch, sub, jti, exp } = payload as Record<string, unknown>;
    if (typeof bid !== 'string' || typeof sub !== 'string' || typeof jti !== 'string') return null;
    if (ch !== 'view' && ch !== 'input') return null;
    for (const [id, at] of spent) if (at <= now) spent.delete(id);
    if (spent.has(jti)) return null;
    spent.set(jti, typeof exp === 'number' ? exp * 1000 : now + 60_000);
    return { boxId: bid, userId: sub, channel: ch };
  } catch {
    return null;
  }
}

let server: WebSocketServer | null = null;
const POLL_MS = 2000;

const say = (ws: WebSocket, m: BoxViewerMessage) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
};

/** `/ws/boxes/view` and `/ws/boxes/input`: the ticket decides, then the socket is proxied. */
export async function acceptBoxUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const channel: Channel = url.pathname.endsWith('/input') ? 'input' : 'view';
  const query = boxViewQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  const grant = query.success ? await spendBoxTicket(query.data.ticket) : null;
  const row = grant && grant.channel === channel ? await boxById(grant.boxId) : null;
  if (!grant || !row || (row.state !== 'agent' && row.state !== 'person')) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nBOX_TICKET_INVALID\r\n');
    return;
  }
  const fps = query.success
    ? (query.data.fps ?? BOX_LIMITS.viewFpsDefault)
    : BOX_LIMITS.viewFpsDefault;
  server ??= new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.handleUpgrade(req, socket, head, (ws) => {
    const run = channel === 'view' ? serveView : serveInput;
    run(ws, row.id, row.deviceId, grant.userId, fps).catch((err) => {
      logger.warn({ err, boxId: row.id, channel }, 'box viewer: proxy ended');
      ws.close(1011, 'box stream ended');
    });
  });
}

/**
 * Tell the socket each time the hold moves, and close it when the box stops running. A read that
 * fails is logged and the next poll reads again: it is not the box gone.
 */
export function followHold(
  ws: WebSocket,
  boxId: string,
  onEnd: () => void,
  onMove?: (b: BoxRecord['holder']) => void,
) {
  let last: string | null = null;
  const timer = setInterval(async () => {
    let row: Awaited<ReturnType<typeof boxById>>;
    try {
      row = await boxById(boxId);
    } catch (err) {
      logger.warn({ err, boxId }, 'box viewer: the box could not be read; the next poll reads again');
      return;
    }
    if (!row || (row.state !== 'agent' && row.state !== 'person')) {
      say(ws, { type: 'closed', why: row ? `the box is ${row.state}` : 'the box is gone' });
      clearInterval(timer);
      onEnd();
      return;
    }
    const holder = holderOf(row);
    const now = holder ? JSON.stringify(holder) : null;
    if (now !== last) {
      last = now;
      say(ws, {
        type: 'holder',
        holder: holder
          ? holder.kind === 'agent'
            ? `agent:${holder.runId ?? 'unnamed'}`
            : `person:${holder.userId}`
          : null,
        since: row.heldSince?.toISOString() ?? null,
      });
      onMove?.(holder);
    }
  }, POLL_MS);
  timer.unref();
  ws.on('close', () => clearInterval(timer));
}

/**
 * What a viewer's message carries on to the box over its view, or null when it is dropped. Only an RFB
 * viewer's binary messages pass: noVNC must send its half of the handshake, and x11vnc runs `-viewonly`
 * so no pointer or key it sends reaches the screen. A JPEG-frames viewer reaches agent-browser's socket,
 * which takes input, and a scrcpy viewer has nothing to say, so theirs are dropped.
 */
export function viewerBytesFor(
  codec: BoxViewCodec,
  data: Buffer | ArrayBuffer | Buffer[],
  isBinary: boolean,
): Buffer | null {
  if (codec !== 'rfb' || !isBinary) return null;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

async function serveView(
  ws: WebSocket,
  boxId: string,
  deviceId: string,
  _userId: string,
  fps: number,
) {
  const row = await rowOf(boxId);
  const codec: BoxViewCodec = row.view?.codec ?? BOX_VIEW_CODECS[row.mode];
  const opened = await openBoxStream(deviceId, { boxId, channel: 'view', fps });
  if (!opened.ok) {
    say(ws, { type: 'closed', why: `the box's device cannot be reached (${opened.why})` });
    ws.close(1013, opened.why);
    return;
  }
  const stream = opened.stream;
  const holder = holderOf(row);
  say(ws, {
    type: 'hello',
    boxId,
    codec,
    width: row.view?.width ?? row.viewport?.width ?? 0,
    height: row.view?.height ?? row.viewport?.height ?? 0,
    fps,
    holder: holder
      ? holder.kind === 'agent'
        ? `agent:${holder.runId ?? 'unnamed'}`
        : `person:${holder.userId}`
      : null,
    watchOnly: true,
  });
  const end = () => {
    stream.destroy();
    ws.close(1000, 'box closed');
  };
  followHold(ws, boxId, end);
  ws.on('close', () => stream.destroy());
  ws.on('message', (data, isBinary) => {
    const bytes = viewerBytesFor(codec, data, isBinary);
    if (bytes) stream.write(bytes);
  });
  if (codec !== 'jpeg-frames') {
    stream.on('data', (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
    });
    stream.on('end', end);
    stream.on('error', end);
    return;
  }
  relayFrames(
    boxId,
    {
      frame: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      fail: (code, why) => {
        say(ws, { type: 'closed', why, code });
        ws.close(1011, code);
      },
      onClose: (fn) => ws.on('close', fn),
    },
    stream,
    () => openBoxStream(deviceId, { boxId, channel: 'view', fps }),
    fps,
  );
}

async function serveInput(ws: WebSocket, boxId: string, deviceId: string, userId: string) {
  const opened = await openBoxStream(deviceId, { boxId, channel: 'input' });
  if (!opened.ok) {
    ws.close(1013, opened.why);
    return;
  }
  const stream = opened.stream;
  const end = () => {
    stream.end();
    ws.close(4409, 'BOX_NOT_HELD');
  };
  followHold(ws, boxId, end, (holder) => {
    if (holder?.kind !== 'person' || holder.userId !== userId) end();
  });
  ws.on('close', () => stream.end());
  stream.on('error', () => ws.close(1011, 'box input stream ended'));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    void holderLine(boxId, userId, data.toString(), {
      refuse: (detail) => ws.send(JSON.stringify({ type: 'refused', detail })),
      forward: (line) => stream.write(line),
      notHeld: end,
      unrecorded: () => {
        stream.end();
        ws.close(1011, 'box input could not be recorded');
      },
    });
  });
}

/**
 * One line the holder sent: refused back where it is no `BoxInput`, else recorded and only then
 * forwarded; the socket ends where the hold is over, or where the record could not be written, so an
 * input is never forwarded unrecorded and a failed write never escapes the socket's handler.
 */
export async function holderLine(
  boxId: string,
  userId: string,
  text: string,
  to: {
    refuse: (detail: string) => void;
    forward: (line: string) => void;
    notHeld: () => void;
    unrecorded: () => void;
  },
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const input = boxInputSchema.safeParse(parsed);
  if (!input.success) {
    to.refuse(input.error.issues[0]?.message ?? 'not a BoxInput');
    return;
  }
  let held: boolean;
  try {
    held = await recordPersonInput(boxId, userId, input.data);
  } catch (err) {
    logger.warn({ err, boxId }, 'box input: a holder input could not be recorded; the socket ends');
    to.unrecorded();
    return;
  }
  if (!held) {
    to.notHeld();
    return;
  }
  to.forward(`${JSON.stringify(input.data)}\n`);
}

export function closeBoxViewers(): void {
  for (const ws of server?.clients ?? []) ws.close(1001, 'server shutting down');
  server?.close();
  server = null;
}
