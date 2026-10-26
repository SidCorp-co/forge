// The chat server operations rooms (REQ-75 BC-20..BC-24) live on, with two bot accounts: a stand-in
// speaking Rocket.Chat's REST under /api/v1 and DDP on /websocket (the default, which CI runs), or a
// real Rocket.Chat named by OPS_E2E_RC — the path of a JSON file
// `{ url, tag, bots: { babo: { userId, authToken }, sy: … }, rooms: { ops: rid, social: rid, group: rid },
//    members: { alice: { userId, authToken, username }, bob: …, carol: …, dave: …, eve: … } }`,
// whose members' addresses are set as `MEMBERS` below says.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import type { BotLine, Member } from './support-chat-server.js';

export type BotName = 'babo' | 'sy';
export type RoomName = 'ops' | 'social' | 'group';
export type MemberName = 'alice' | 'bob' | 'carol' | 'dave' | 'eve';

/** Each member's address on the chat server and whether the server verified it. */
export const MEMBERS: Record<MemberName, { email: (tag: string) => string; verified: boolean }> = {
  alice: { email: (t) => `alice-${t}@ops.test`, verified: true },
  bob: { email: (t) => `bob-${t}@ops.test`, verified: true },
  carol: { email: (t) => `carol-${t}@elsewhere.test`, verified: true },
  // dave's verified address names a Forge viewer; the explicit link, which must win, an admin
  dave: { email: (t) => `dave-${t}@ops.test`, verified: true },
  // eve's address names a Forge admin, and the chat server never verified it
  eve: { email: (t) => `eve-${t}@ops.test`, verified: false },
};

/** Which bot is in which room, as the setup binds them. */
export const ROOM_BOT: Record<RoomName, BotName> = { ops: 'babo', group: 'babo', social: 'sy' };

export interface OpsChat {
  serverUrl: string;
  bots: Record<BotName, { userId: string; authToken: string }>;
  rooms: Record<RoomName, string>;
  members: Record<MemberName, Member>;
  /** The tag the members' addresses are made unique with in this run. */
  tag: string;
  say(who: MemberName, room: RoomName, text: string, tmid?: string): Promise<string>;
  /** Every line `bot` posted in `room` since the world started, oldest first. */
  botLines(room: RoomName): Promise<BotLine[]>;
  close(): Promise<void>;
}

export class StandInOpsChat implements OpsChat {
  serverUrl = '';
  readonly tag = randomUUID().slice(0, 8);
  readonly bots: Record<BotName, { userId: string; authToken: string }> = {
    babo: { userId: 'bot-babo', authToken: `rc-babo-${randomUUID()}` },
    sy: { userId: 'bot-sy', authToken: `rc-sy-${randomUUID()}` },
  };
  readonly rooms: Record<RoomName, string> = {
    ops: `OPS${this.tag}`,
    social: `SOC${this.tag}`,
    group: `GRP${this.tag}`,
  };
  readonly members: Record<MemberName, Member> = {
    alice: { userId: 'u-alice', username: 'alice' },
    bob: { userId: 'u-bob', username: 'bob' },
    carol: { userId: 'u-carol', username: 'carol' },
    dave: { userId: 'u-dave', username: 'dave' },
    eve: { userId: 'u-eve', username: 'eve' },
  };
  private readonly lines: (BotLine & { rid: string })[] = [];
  private server!: Server;
  private wss!: WebSocketServer;
  private subs = new Set<{ ws: WebSocket; id: string; bot: BotName }>();
  private seq = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.rest(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/websocket') return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.ddp(ws));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.serverUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private botOf(token: unknown): BotName | null {
    return (
      (Object.keys(this.bots) as BotName[]).find((b) => this.bots[b].authToken === token) ?? null
    );
  }

  private roomsOf(bot: BotName): string[] {
    return (Object.keys(ROOM_BOT) as RoomName[])
      .filter((r) => ROOM_BOT[r] === bot)
      .map((r) => this.rooms[r]);
  }

  private async rest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const url = new URL(req.url ?? '/', this.serverUrl);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const bot = this.botOf(req.headers['x-auth-token']);
    if (!bot) return json(401, { success: false });
    switch (url.pathname) {
      case '/api/v1/me':
        return json(200, { _id: this.bots[bot].userId, username: bot, name: bot });
      case '/api/v1/rooms.info':
        return json(200, {
          success: true,
          room: { _id: url.searchParams.get('roomId'), t: 'p', name: 'ops-room' },
        });
      case '/api/v1/users.info': {
        const id = url.searchParams.get('userId');
        const name = (Object.keys(this.members) as MemberName[]).find(
          (m) => this.members[m].userId === id,
        );
        if (!name) return json(400, { success: false });
        const { email, verified } = MEMBERS[name];
        return json(200, {
          success: true,
          user: { _id: id, username: name, emails: [{ address: email(this.tag), verified }] },
        });
      }
      case '/api/v1/chat.react':
        return json(200, { success: true });
      case '/api/v1/chat.postMessage': {
        this.seq += 1;
        const id = `m${this.seq.toString().padStart(6, '0')}`;
        const rid = String(body.roomId ?? body.channel);
        this.lines.push({
          id,
          rid,
          text: String(body.text),
          tmid: body.tmid ?? null,
          attachments: body.attachments ?? [],
        });
        this.push(rid, {
          _id: id,
          rid,
          msg: body.text,
          tmid: body.tmid,
          u: { _id: this.bots[bot].userId, username: bot },
        });
        return json(200, { success: true, message: { _id: id } });
      }
      default:
        return json(404, { success: false, error: `the stand-in serves no ${url.pathname}` });
    }
  }

  private ddp(ws: WebSocket): void {
    let as: BotName | null = null;
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as {
        msg: string;
        id?: string;
        method?: string;
        params?: unknown[];
      };
      if (f.msg === 'connect') ws.send(JSON.stringify({ msg: 'connected', session: 's1' }));
      if (f.msg === 'ping') ws.send(JSON.stringify({ msg: 'pong', id: f.id }));
      if (f.msg === 'method' && f.method === 'login') {
        as = this.botOf((f.params?.[0] as { resume?: string } | undefined)?.resume);
        ws.send(
          JSON.stringify(
            as
              ? { msg: 'result', id: f.id, result: { id: this.bots[as].userId, token: 'ok' } }
              : { msg: 'result', id: f.id, error: { error: 403 } },
          ),
        );
      }
      if (f.msg === 'sub' && f.id && as) {
        this.subs.add({ ws, id: f.id, bot: as });
        ws.send(JSON.stringify({ msg: 'ready', subs: [f.id] }));
      }
    });
    ws.on('close', () => {
      for (const s of this.subs) if (s.ws === ws) this.subs.delete(s);
    });
  }

  /** A message in `rid`, to every bot in that room, as Rocket.Chat streams it. */
  private push(rid: string, message: Record<string, unknown>): void {
    const frame = JSON.stringify({
      msg: 'changed',
      collection: 'stream-room-messages',
      id: 'id',
      fields: { eventName: '__my_messages__', args: [{ ts: { $date: Date.now() }, ...message }] },
    });
    for (const s of this.subs) if (this.roomsOf(s.bot).includes(rid)) s.ws.send(frame);
  }

  async say(who: MemberName, room: RoomName, text: string, tmid?: string): Promise<string> {
    const bot = ROOM_BOT[room];
    await expect
      .poll(() => [...this.subs].filter((s) => s.bot === bot).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    this.seq += 1;
    const id = `m${this.seq.toString().padStart(6, '0')}`;
    const member = this.members[who];
    this.push(this.rooms[room], {
      _id: id,
      rid: this.rooms[room],
      msg: text,
      ...(tmid ? { tmid } : {}),
      u: { _id: member.userId, username: member.username },
    });
    return id;
  }

  async botLines(room: RoomName): Promise<BotLine[]> {
    return this.lines.filter((l) => l.rid === this.rooms[room]).map(({ rid: _rid, ...l }) => l);
  }

  async close(): Promise<void> {
    for (const s of this.subs) s.ws.close();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** A real Rocket.Chat with the two bots, read from the file OPS_E2E_RC names. */
export class RealOpsChat implements OpsChat {
  readonly serverUrl: string;
  readonly bots: Record<BotName, { userId: string; authToken: string }>;
  readonly rooms: Record<RoomName, string>;
  readonly members: Record<MemberName, Member>;
  readonly tag: string;
  private readonly since = new Date();

  constructor(file: string) {
    const c = JSON.parse(readFileSync(file, 'utf8')) as {
      url: string;
      tag: string;
      bots: Record<BotName, { userId: string; authToken: string }>;
      rooms: Record<RoomName, string>;
      members: Record<MemberName, Member>;
    };
    this.serverUrl = c.url;
    this.tag = c.tag;
    this.bots = c.bots;
    this.rooms = c.rooms;
    this.members = c.members;
  }

  private async call(as: { userId: string; authToken?: string }, path: string, body?: unknown) {
    const res = await fetch(`${this.serverUrl}/api/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-User-Id': as.userId,
        'X-Auth-Token': as.authToken ?? '',
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok || json.success === false) throw new Error(`${path} answered ${res.status}`);
    return json;
  }

  async say(who: MemberName, room: RoomName, text: string, tmid?: string): Promise<string> {
    const out = await this.call(this.members[who], 'chat.postMessage', {
      roomId: this.rooms[room],
      text,
      ...(tmid ? { tmid } : {}),
    });
    return (out.message as { _id: string })._id;
  }

  async botLines(room: RoomName): Promise<BotLine[]> {
    const bot = this.bots[ROOM_BOT[room]];
    const q = new URLSearchParams({
      roomId: this.rooms[room],
      count: '200',
      oldest: this.since.toISOString(),
    });
    const out = await this.call(bot, `groups.history?${q}`);
    const messages = out.messages as {
      _id: string;
      msg: string;
      tmid?: string;
      u: { _id: string };
      attachments?: BotLine['attachments'];
    }[];
    return messages
      .filter((m) => m.u._id === bot.userId)
      .reverse()
      .map((m) => ({
        id: m._id,
        text: m.msg,
        tmid: m.tmid ?? null,
        attachments: m.attachments ?? [],
      }));
  }

  async close(): Promise<void> {}
}

export async function opsChat(): Promise<OpsChat> {
  const file = process.env.OPS_E2E_RC;
  if (file) return new RealOpsChat(file);
  const standIn = new StandInOpsChat();
  await standIn.start();
  return standIn;
}
