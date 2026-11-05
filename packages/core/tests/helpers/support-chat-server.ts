// The chat server a support group (REQ-75) lives on, as the bot meets it: a stand-in speaking
// Rocket.Chat's REST under /api/v1 and DDP on /websocket (the default, which CI runs), or a real
// Rocket.Chat named by SUPPORT_E2E_RC — the path of a JSON file
// `{ url, rid, bot: { userId, authToken }, members: { alice: { userId, authToken, username }, bob: … } }`.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { RealRocketChat } from './support-real-chat-server.js';

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
  /** The image a line posts, where it is one (`rooms.mediaConfirm`, ISS-1024). */
  file?: { name: string; mime: string; bytes: Buffer };
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
  /** A second group the bot is a member of, which a channel agent's binding names beside the first (REQ-77). */
  readonly rid2 = `GRP${randomUUID().slice(0, 8)}`;
  /** Two more groups, answered by bots outside Forge until each one's switch (REQ-77 BC-16..BC-19). */
  readonly rid3 = `GRP${randomUUID().slice(0, 8)}`;
  readonly rid4 = `GRP${randomUUID().slice(0, 8)}`;
  /** Every account `groups.kick` removed, and from which group. */
  readonly kicked: { rid: string; userId: string }[] = [];
  /** Whether the server refuses the bot's `groups.kick`, as one without the right to remove members does. */
  kickRefused = false;
  readonly bot = { userId: 'bot-support', authToken: `rc-bot-${randomUUID()}` };
  readonly alice: Member = { userId: 'u-alice', username: 'alice' };
  readonly bob: Member = { userId: 'u-bob', username: 'bob' };
  readonly lines: (BotLine & { at: number; rid: string })[] = [];
  readonly reactions: { messageId: string; emoji: string }[] = [];
  /** The address the server reports for an account (`users.info`), where a test set one. */
  readonly emails = new Map<string, string>();
  /** Whether the bot is a member of the group (`subscriptions.getOne` answers its subscription). */
  botIsMember = true;
  private server!: Server;
  private wss!: WebSocketServer;
  private subs = new Set<{ ws: WebSocket; id: string }>();
  /** Every subscription core has made to the message stream: one more each time it redials. */
  subscriptions = 0;
  /** Every message the groups hold, as `groups.history` serves it: members', the bot's and apps'. */
  private readonly history: Record<string, unknown>[] = [];

  /**
   * A message written in group `rid` at `at` while no binding answered it: kept in the group's
   * history, never on the stream core listens to (ISS-933). `bot` marks an app's or another bot's.
   */
  wroteWhileAway(rid: string, who: Member, text: string, at: Date, opts: { bot?: boolean } = {}) {
    const id = this.nextId();
    this.history.push({
      _id: id,
      rid,
      msg: text,
      ts: at.toISOString(),
      u: { _id: who.userId, username: who.username },
      mentions: this.mentionsIn(text),
      ...(opts.bot ? { bot: { i: 'app' } } : {}),
    });
    return id;
  }

  /**
   * The files members uploaded, served at `/file-upload/<id>/<name>` to the bot's credential alone,
   * as Rocket.Chat serves them (ISS-1010). `status` makes the server answer that instead of the
   * bytes.
   */
  readonly uploads = new Map<string, { bytes: Buffer; mime: string; status?: number }>();
  /** Every upload the bot fetched, by id. */
  readonly uploadReads: string[] = [];
  /** Every image the bot uploaded with `rooms.media`, posted or not (ISS-1024). */
  readonly media = new Map<string, { rid: string; name: string; mime: string; bytes: Buffer }>();
  /** Whether `rooms.media` refuses the bot's upload, as a server whose upload limit it passes does. */
  mediaRefused = false;

  /** How many times a group's history was read. */
  historyReads = 0;
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
    const raw = Buffer.concat(chunks);
    const multipart = String(req.headers['content-type'] ?? '').startsWith('multipart/form-data');
    const body = chunks.length && !multipart ? JSON.parse(raw.toString('utf8')) : {};
    const url = new URL(req.url ?? '/', this.serverUrl);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers['x-auth-token'] !== this.bot.authToken) return json(401, { success: false });
    if (url.pathname.startsWith('/file-upload/')) return this.serveUpload(url.pathname, res);
    if (url.pathname.startsWith('/api/v1/rooms.media/')) {
      const rid = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      return json(...(await this.stageMedia(rid, raw, String(req.headers['content-type']))));
    }
    if (url.pathname.startsWith('/api/v1/rooms.mediaConfirm/')) {
      const [, , , , rid = '', fileId = ''] = url.pathname.split('/').map(decodeURIComponent);
      return json(...this.confirmMedia(rid, fileId, body.tmid));
    }
    switch (url.pathname) {
      case '/api/v1/me':
        return json(200, { _id: this.bot.userId, username: 'supportbot', name: 'Support' });
      case '/api/v1/rooms.info': {
        const asked = url.searchParams.get('roomId') ?? this.rid;
        return json(200, {
          success: true,
          room: { _id: asked, t: 'p', name: this.nameOf(asked) },
        });
      }
      case '/api/v1/rooms.get':
        return json(200, {
          success: true,
          update: this.botIsMember ? [{ _id: this.rid, t: 'p', name: 'catalog-support' }] : [],
        });
      case '/api/v1/subscriptions.getOne':
        return json(200, {
          success: true,
          subscription:
            this.botIsMember && this.rooms().includes(url.searchParams.get('roomId') ?? '')
              ? {
                  rid: url.searchParams.get('roomId'),
                  name: this.nameOf(url.searchParams.get('roomId') ?? ''),
                  fname: this.nameOf(url.searchParams.get('roomId') ?? ''),
                }
              : null,
        });
      case '/api/v1/groups.kick':
        if (this.kickRefused) {
          return json(403, {
            success: false,
            error: 'Not allowed',
            errorType: 'error-not-allowed',
          });
        }
        this.kicked.push({ rid: String(body.roomId), userId: String(body.userId) });
        return json(200, { success: true });
      case '/api/v1/users.info': {
        const id = url.searchParams.get('userId') ?? '';
        const member = [this.alice, this.bob].find((m) => m.userId === id);
        if (!member) return json(400, { success: false, error: 'User not found' });
        const email = this.emails.get(id);
        return json(200, {
          success: true,
          user: {
            _id: id,
            username: member.username,
            ...(email ? { emails: [{ address: email, verified: true }] } : {}),
          },
        });
      }
      case '/api/v1/groups.history': {
        this.historyReads += 1;
        const rid = url.searchParams.get('roomId') ?? '';
        const oldest = url.searchParams.get('oldest') ?? '';
        const count = Number(url.searchParams.get('count') ?? '50');
        const messages = this.history
          .filter((m) => m.rid === rid && String(m.ts) > oldest)
          .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
          .slice(0, count);
        return json(200, { success: true, messages });
      }
      case '/api/v1/chat.getMessage': {
        // any message a group holds, the bot's own and an app's included, with the room it is in
        const found = this.history.find((m) => m._id === url.searchParams.get('msgId'));
        if (!found) return json(400, { success: false, error: 'error-not-allowed' });
        return json(200, { success: true, message: found });
      }
      case '/api/v1/chat.react':
        this.reactions.push({ messageId: body.messageId, emoji: body.emoji });
        return json(200, { success: true });
      case '/api/v1/chat.postMessage': {
        const id = this.nextId();
        this.lines.push({
          id,
          rid: String(body.roomId ?? body.channel ?? this.rid),
          text: String(body.text),
          tmid: body.tmid ?? null,
          attachments: body.attachments ?? [],
          at: Date.now(),
        });
        // the server echoes the bot's own message on its stream, as Rocket.Chat does
        this.push({
          _id: id,
          rid: String(body.roomId ?? body.channel ?? this.rid),
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

  /** `rooms.media/:rid`: the file held for the bot, posted by nobody until it is confirmed. */
  private async stageMedia(rid: string, raw: Buffer, type: string): Promise<[number, unknown]> {
    if (this.mediaRefused) return [400, { success: false, error: 'error-file-too-large' }];
    const form = await new Response(new Uint8Array(raw), {
      headers: { 'content-type': type },
    }).formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) return [400, { success: false, error: 'No file uploaded' }];
    const id = `F${randomUUID().slice(0, 12)}`;
    this.media.set(id, {
      rid,
      name: (file as File).name,
      mime: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return [200, { success: true, file: { _id: id, url: `/file-upload/${id}/x` } }];
  }

  /** `rooms.mediaConfirm/:rid/:fileId`: the held file posted as the bot's message, in `tmid` where given. */
  private confirmMedia(rid: string, fileId: string, tmid: unknown): [number, unknown] {
    const file = this.media.get(fileId);
    if (!file || file.rid !== rid) return [400, { success: false, error: 'invalid-file' }];
    const id = this.nextId();
    this.lines.push({
      id,
      rid,
      text: '',
      tmid: typeof tmid === 'string' ? tmid : null,
      attachments: [],
      file: { name: file.name, mime: file.mime, bytes: file.bytes },
      at: Date.now(),
    });
    return [200, { success: true, message: { _id: id } }];
  }

  private serveUpload(path: string, res: ServerResponse): void {
    const id = path.split('/')[2] ?? '';
    this.uploadReads.push(id);
    const file = this.uploads.get(id);
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (file.status) {
      res.writeHead(file.status);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': file.mime,
      'content-length': String(file.bytes.byteLength),
    });
    res.end(file.bytes);
  }

  /**
   * `who` posts `text` with pictures in the group, as Rocket.Chat records an upload: the files on
   * `file`/`files`, each also an attachment whose `image_url` is its `/file-upload` path (a picture
   * named by `url` points wherever it says instead). Answers the message id and each upload's id.
   */
  async sayWithImages(
    who: Member,
    text: string,
    images: readonly {
      name: string;
      mime: string;
      bytes?: Buffer;
      status?: number;
      url?: string;
    }[],
    tmid?: string,
  ): Promise<{ id: string; uploads: string[] }> {
    await expect.poll(() => this.subs.size, { timeout: 15_000 }).toBeGreaterThan(0);
    const id = this.nextId();
    const uploads: string[] = [];
    const files: { _id: string; name: string; type: string }[] = [];
    const attachments: Record<string, unknown>[] = [];
    for (const img of images) {
      if (img.url) {
        attachments.push({ title: img.name, image_url: img.url, image_type: img.mime });
        continue;
      }
      const fileId = `F${randomUUID().slice(0, 12)}`;
      uploads.push(fileId);
      this.uploads.set(fileId, {
        bytes: img.bytes ?? Buffer.alloc(0),
        mime: img.mime,
        ...(img.status ? { status: img.status } : {}),
      });
      files.push({ _id: fileId, name: img.name, type: img.mime });
      const path = `/file-upload/${fileId}/${encodeURIComponent(img.name)}`;
      attachments.push({
        title: img.name,
        title_link: path,
        image_url: path,
        image_type: img.mime,
      });
    }
    this.push({
      _id: id,
      rid: this.rid,
      msg: text,
      ...(tmid ? { tmid } : {}),
      ...(files[0] ? { file: files[0], files } : {}),
      attachments,
      mentions: this.mentionsIn(text),
      u: { _id: who.userId, username: who.username },
    });
    return { id, uploads };
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
        this.subscriptions += 1;
        this.subs.add({ ws, id: f.id });
        ws.send(JSON.stringify({ msg: 'ready', subs: [f.id] }));
      }
    });
    ws.on('close', () => {
      for (const s of this.subs) if (s.ws === ws) this.subs.delete(s);
    });
  }

  private push(message: Record<string, unknown>, ts = Date.now()): void {
    this.history.push({ ...message, ts: new Date(ts).toISOString() });
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

  /** `say` in the group `rid` (the second group, where a channel agent's binding names two). */
  async sayIn(rid: string, who: Member, text: string, tmid?: string): Promise<string> {
    return this.sayAt(Date.now(), who, text, tmid, rid);
  }

  private rooms(): string[] {
    return [this.rid, this.rid2, this.rid3, this.rid4];
  }

  private nameOf(rid: string): string {
    return rid === this.rid2 ? 'catalog-team' : 'catalog-support';
  }

  /** `say`, the server stamping the message at `ts` (a message the stream carries late). */
  async sayAt(
    ts: number,
    who: Member,
    text: string,
    tmid?: string,
    rid: string = this.rid,
  ): Promise<string> {
    await expect.poll(() => this.subs.size, { timeout: 15_000 }).toBeGreaterThan(0);
    const id = this.nextId();
    this.push(
      {
        _id: id,
        rid,
        msg: text,
        ...(tmid ? { tmid } : {}),
        mentions: this.mentionsIn(text),
        u: { _id: who.userId, username: who.username },
      },
      ts,
    );
    return id;
  }

  /** The stream carrying message `id` again, as a reconnect replays a frame core already took. */
  async resend(id: string, who: Member, text: string, tmid?: string): Promise<void> {
    await expect.poll(() => this.subs.size, { timeout: 15_000 }).toBeGreaterThan(0);
    this.push({
      _id: id,
      rid: this.rid,
      msg: text,
      ...(tmid ? { tmid } : {}),
      mentions: this.mentionsIn(text),
      u: { _id: who.userId, username: who.username },
    });
  }

  /** The users a message names with `@`, as Rocket.Chat parses them onto the message. */
  private mentionsIn(text: string): { _id: string; username: string }[] {
    const known = [
      { _id: this.bot.userId, username: 'supportbot' },
      { _id: this.alice.userId, username: this.alice.username },
      { _id: this.bob.userId, username: this.bob.username },
    ];
    const named = new Set([...text.matchAll(/@([A-Za-z0-9._-]+)/g)].map((m) => m[1]));
    return known.filter((u) => named.has(u.username));
  }

  async botLines(): Promise<BotLine[]> {
    return this.lines.map(({ at: _at, rid: _rid, ...l }) => l);
  }

  /** The bot's lines in one group, oldest first. */
  linesIn(rid: string): BotLine[] {
    return this.lines.filter((l) => l.rid === rid).map(({ at: _at, rid: _rid, ...l }) => l);
  }

  async close(): Promise<void> {
    for (const s of this.subs) s.ws.close();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** The chat server the run names: the real one SUPPORT_E2E_RC points at, or a stand-in. */
export async function chatServer(): Promise<ChatServer> {
  const file = process.env.SUPPORT_E2E_RC;
  if (file) return new RealRocketChat(file);
  const standIn = new StandInRocketChat();
  await standIn.start();
  return standIn;
}
