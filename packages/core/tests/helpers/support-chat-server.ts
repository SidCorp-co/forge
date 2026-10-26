// The chat server a support group (REQ-75) lives on, as the bot meets it: a stand-in speaking
// Rocket.Chat's REST under /api/v1 and DDP on /websocket (the default, which CI runs), or a real
// Rocket.Chat named by SUPPORT_E2E_RC — the path of a JSON file
// `{ url, rid, bot: { userId, authToken }, members: { alice: { userId, authToken, username }, bob: … } }`.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

export interface Member {
  userId: string;
  username: string;
  authToken?: string;
}

/** One line the bot posted in the group. */
export interface BotLine {
  id: string;
  text: string;
  tmid: string | null;
  attachments: { actions?: { text: string; msg: string }[] }[];
}

/** What a test needs of a chat server, stand-in or real. */
export interface ChatServer {
  serverUrl: string;
  rid: string;
  bot: { userId: string; authToken: string };
  alice: Member;
  bob: Member;
  /** `who` writes `text` in the group, in thread `tmid` when given; answers the message id. */
  say(who: Member, text: string, tmid?: string): Promise<string>;
  /** Every line the bot posted since the world started, oldest first. */
  botLines(): Promise<BotLine[]>;
  close(): Promise<void>;
}

/** Rocket.Chat as the bot meets it: REST under /api/v1 and DDP on /websocket, for one group. */
export class StandInRocketChat implements ChatServer {
  serverUrl = '';
  readonly rid = `GRP${randomUUID().slice(0, 8)}`;
  readonly bot = { userId: 'bot-support', authToken: `rc-bot-${randomUUID()}` };
  readonly alice: Member = { userId: 'u-alice', username: 'alice' };
  readonly bob: Member = { userId: 'u-bob', username: 'bob' };
  readonly lines: (BotLine & { at: number })[] = [];
  readonly reactions: { messageId: string; emoji: string }[] = [];
  private server!: Server;
  private wss!: WebSocketServer;
  private subs = new Set<{ ws: WebSocket; id: string }>();
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

  private nextId(): string {
    this.seq += 1;
    return `m${this.seq.toString().padStart(6, '0')}`;
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
    if (req.headers['x-auth-token'] !== this.bot.authToken) return json(401, { success: false });
    switch (url.pathname) {
      case '/api/v1/me':
        return json(200, { _id: this.bot.userId, username: 'supportbot', name: 'Support' });
      case '/api/v1/rooms.info':
        return json(200, {
          success: true,
          room: { _id: this.rid, t: 'p', name: 'catalog-support' },
        });
      case '/api/v1/chat.react':
        this.reactions.push({ messageId: body.messageId, emoji: body.emoji });
        return json(200, { success: true });
      case '/api/v1/chat.postMessage': {
        const id = this.nextId();
        this.lines.push({
          id,
          text: String(body.text),
          tmid: body.tmid ?? null,
          attachments: body.attachments ?? [],
          at: Date.now(),
        });
        // the server echoes the bot's own message on its stream, as Rocket.Chat does
        this.push({
          _id: id,
          rid: this.rid,
          msg: body.text,
          tmid: body.tmid,
          u: { _id: this.bot.userId, username: 'supportbot' },
        });
        return json(200, { success: true, message: { _id: id } });
      }
      default:
        return json(404, { success: false, error: `the stand-in serves no ${url.pathname}` });
    }
  }

  private ddp(ws: WebSocket): void {
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
        const resume = (f.params?.[0] as { resume?: string } | undefined)?.resume;
        ws.send(
          JSON.stringify(
            resume === this.bot.authToken
              ? { msg: 'result', id: f.id, result: { id: this.bot.userId, token: resume } }
              : { msg: 'result', id: f.id, error: { error: 403 } },
          ),
        );
      }
      if (f.msg === 'sub' && f.id) {
        this.subs.add({ ws, id: f.id });
        ws.send(JSON.stringify({ msg: 'ready', subs: [f.id] }));
      }
    });
    ws.on('close', () => {
      for (const s of this.subs) if (s.ws === ws) this.subs.delete(s);
    });
  }

  private push(message: Record<string, unknown>, ts = Date.now()): void {
    const frame = JSON.stringify({
      msg: 'changed',
      collection: 'stream-room-messages',
      id: 'id',
      fields: {
        eventName: '__my_messages__',
        // DDP sends a date as EJSON, as Rocket.Chat does
        args: [{ ts: { $date: ts }, ...message }],
      },
    });
    for (const s of this.subs) s.ws.send(frame);
  }

  async say(who: Member, text: string, tmid?: string): Promise<string> {
    return this.sayAt(Date.now(), who, text, tmid);
  }

  /** `say`, the server stamping the message at `ts` (a message the stream carries late). */
  async sayAt(ts: number, who: Member, text: string, tmid?: string): Promise<string> {
    await expect.poll(() => this.subs.size, { timeout: 15_000 }).toBeGreaterThan(0);
    const id = this.nextId();
    this.push(
      {
        _id: id,
        rid: this.rid,
        msg: text,
        ...(tmid ? { tmid } : {}),
        u: { _id: who.userId, username: who.username },
      },
      ts,
    );
    return id;
  }

  async botLines(): Promise<BotLine[]> {
    return this.lines.map(({ at: _at, ...l }) => l);
  }

  async close(): Promise<void> {
    for (const s of this.subs) s.ws.close();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** A real Rocket.Chat, read from the file SUPPORT_E2E_RC names. */
export class RealRocketChat implements ChatServer {
  readonly serverUrl: string;
  readonly rid: string;
  readonly bot: { userId: string; authToken: string };
  readonly alice: Member;
  readonly bob: Member;
  private readonly since = new Date();

  constructor(file: string) {
    const c = JSON.parse(readFileSync(file, 'utf8')) as {
      url: string;
      rid: string;
      bot: { userId: string; authToken: string };
      members: { alice: Member; bob: Member };
    };
    this.serverUrl = c.url;
    this.rid = c.rid;
    this.bot = c.bot;
    this.alice = c.members.alice;
    this.bob = c.members.bob;
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

  async say(who: Member, text: string, tmid?: string): Promise<string> {
    const out = await this.call(who, 'chat.postMessage', {
      roomId: this.rid,
      text,
      ...(tmid ? { tmid } : {}),
    });
    return (out.message as { _id: string })._id;
  }

  async botLines(): Promise<BotLine[]> {
    const q = new URLSearchParams({
      roomId: this.rid,
      count: '200',
      oldest: this.since.toISOString(),
    });
    const out = await this.call(this.bot, `groups.history?${q}`);
    const messages = out.messages as {
      _id: string;
      msg: string;
      tmid?: string;
      u: { _id: string };
      attachments?: BotLine['attachments'];
    }[];
    return messages
      .filter((m) => m.u._id === this.bot.userId)
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

/** The chat server the run names: the real one SUPPORT_E2E_RC points at, or a stand-in. */
export async function chatServer(): Promise<ChatServer> {
  const file = process.env.SUPPORT_E2E_RC;
  if (file) return new RealRocketChat(file);
  const standIn = new StandInRocketChat();
  await standIn.start();
  return standIn;
}
