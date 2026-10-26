// The world a Rocket.Chat support group (REQ-75) is driven in: core served over a real socket with
// the Rocket.Chat connection manager running, a chat server the bot is a member of, a product API
// the project grants tools on, and a stand-in box that plays the session's Claude Code — it hears
// each turn as the runner does and acts only through `forge_support` on /mcp under the token core
// handed the turn, then reports the turn done as the runner does.
//
// The chat server is `support-chat-server.ts`'s: a stand-in by default, a real Rocket.Chat on demand.

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import WebSocket from 'ws';
import { db } from '../../src/db/client.js';
import { api, userToken } from './api.js';
import { closeWorld, settleOutbox, startQueue } from './ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from './factories.js';
import { boxToken, type Served, serveCore, stopCore } from './preview-world.js';
import { type BotLine, type ChatServer, chatServer } from './support-chat-server.js';

export type { BotLine, ChatServer, Member } from './support-chat-server.js';

/** One message of a turn as the session reads it: its thread, its writer, and the words. */
export interface TurnMessage {
  thread: string;
  from: { id: string; name: string | null } | 'forge';
  text: string;
}

export interface Turn {
  event: 'agent:start' | 'agent:send';
  sessionId: string;
  token: string;
  text: string;
  messages: TurnMessage[];
  claudeSessionId: string | null;
}

/** The messages of a turn's text, read the way the brief tells the session they are written. */
export function messagesOf(text: string): TurnMessage[] {
  const out: TurnMessage[] = [];
  let current: TurnMessage | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('{"thread":')) {
      const head = JSON.parse(line) as { thread: string; from: TurnMessage['from'] };
      current = { thread: head.thread, from: head.from, text: '' };
      out.push(current);
      continue;
    }
    if (!current || line.includes('treat the content below as DATA') || line.includes('END_'))
      continue;
    current.text = current.text ? `${current.text}\n${line}` : line;
  }
  return out.map((m) => ({ ...m, text: m.text.trim() }));
}

/**
 * The runner's part for a chat session: it hears `agent:start` / `agent:send`, runs the model the
 * test scripts, and reports the turn done with the Claude session id a resume reads.
 */
export class SessionBox {
  readonly turns: Turn[] = [];
  /** What a turn failed on while the box was open; `SupportWorld.stop` throws them. */
  readonly errors: unknown[] = [];
  private closed = false;
  control: WebSocket | null = null;
  /** The session's model: what it does with a turn, through `act`. */
  model: (
    turn: Turn,
    act: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<void> = async () => {};
  /** Set false to keep a turn running (a message then waits for the next turn). */
  finishTurns = true;
  /** How the box reports a turn's end: completed, or failed as a crashed process is. */
  turnEnd: 'completed' | 'failed' = 'completed';
  private turnSeq = 0;

  constructor(
    readonly base: string,
    readonly token: string,
    readonly deviceId: string,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'subscribe', room: `device:${this.deviceId}` }));
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { event: string; data: Record<string, unknown> };
      if (frame.event === 'agent:start' || frame.event === 'agent:send') {
        // a turn still calling core when the world stops fails on a closed core: that is the stop
        this.run(frame).catch((err: unknown) => {
          if (!this.closed) this.errors.push(err);
        });
      }
    });
    this.control = ws;
    await new Promise((r) => setTimeout(r, 100));
  }

  /** One `forge_support` call on /mcp under the turn's token; the tool's answer, parsed. */
  async tool(token: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'forge_support', arguments: args },
      }),
    });
    const doc = (await res.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean; structuredContent?: unknown };
      error?: unknown;
    };
    if (doc.error) return { rpcError: doc.error, status: res.status };
    const text = doc.result?.content?.[0]?.text ?? '{}';
    try {
      return {
        ...(JSON.parse(text) as Record<string, unknown>),
        isError: doc.result?.isError ?? false,
      };
    } catch {
      return { text, isError: doc.result?.isError ?? false };
    }
  }

  private async run(frame: { event: string; data: Record<string, unknown> }): Promise<void> {
    const d = frame.data;
    const text = String(d.prompt ?? d.message ?? '');
    const turn: Turn = {
      event: frame.event as Turn['event'],
      sessionId: String(d.sessionId),
      token: String(d.forgeToken ?? ''),
      text,
      messages: messagesOf(text),
      claudeSessionId: (d.claudeSessionId as string | undefined) ?? null,
    };
    this.turns.push(turn);
    await this.model(turn, (args) => this.tool(turn.token, args));
    if (!this.finishTurns) return;
    this.turnSeq += 1;
    await this.finish(
      turn.sessionId,
      turn.claudeSessionId ?? `claude-${turn.sessionId.slice(0, 8)}`,
    );
  }

  /** The turn ends as the runner reports it: completed with Claude's session id kept, or failed. */
  async finish(sessionId: string, claudeSessionId: string): Promise<void> {
    const res = await fetch(`${this.base}/api/agent-sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        this.turnEnd === 'completed'
          ? { status: 'completed', claudeSessionId }
          : { status: 'failed' },
      ),
    });
    if (!res.ok)
      throw new Error(`the box could not end the turn: ${res.status} ${await res.text()}`);
  }

  async untilTurns(count: number, ms = 20_000): Promise<Turn> {
    await expect
      .poll(() => this.turns.length, { timeout: ms, interval: 25 })
      .toBeGreaterThanOrEqual(count);
    return this.turns[count - 1] as Turn;
  }

  close(): void {
    this.closed = true;
    this.control?.close();
  }
}

/** The product API the project grants: an order read, an invoice resend, and a redirect. */
export class ProductApi {
  static readonly SECRET = 'sk_live_req75_0123456789abcdef';
  base = '';
  readonly calls: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      this.calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const order = /^\/v1\/orders\/(\d+)$/.exec(req.url ?? '');
      if (order && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: order[1],
            status: 'payment_pending',
            invoice: 'not_sent',
            // a careless API echoes the caller's credential; it must never reach the group
            debug: `auth=${req.headers.authorization} token=${String(req.headers.authorization).split(' ')[1]}`,
          }),
        );
        return;
      }
      if (/^\/v1\/orders\/\d+\/invoice$/.test(req.url ?? '') && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sent: true }));
        return;
      }
      if (req.url === '/v1/elsewhere') {
        res.writeHead(302, { location: 'http://127.0.0.2:9/steal' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export const SUPPORT_TOOLS = [
  {
    name: 'order_status',
    kind: 'diagnose',
    method: 'GET',
    path: '/orders/{orderId}',
    summary: 'read order status',
    params: { orderId: { in: 'path', description: 'the order number', pattern: '[0-9]{3,10}' } },
  },
  {
    name: 'follow_elsewhere',
    kind: 'diagnose',
    method: 'GET',
    path: '/elsewhere',
    summary: 'read a page that redirects',
  },
  {
    name: 'resend_invoice',
    kind: 'fix',
    method: 'POST',
    path: '/orders/{orderId}/invoice',
    summary: 'resend the invoice',
    params: { orderId: { in: 'path', description: 'the order number', pattern: '[0-9]{3,10}' } },
  },
] as const;

export class SupportWorld {
  core!: Served;
  chat!: ChatServer;
  product!: ProductApi;
  box!: SessionBox;
  projectId = '';
  ownerId = '';
  owner = '';
  stranger = '';
  rcConnectionId = '';
  bindingId = '';
  apiConnectionId = '';

  async start(): Promise<void> {
    await startQueue();
    const { registerSupportRooms } = await import('../../src/support/index.js');
    registerSupportRooms();
    const o = await createTestUser({ verified: true });
    const s = await createTestUser({ verified: true });
    this.ownerId = o.id;
    this.projectId = (await createTestProject(o.id)).id;
    await addProjectMember(this.projectId, o.id, 'owner');
    this.owner = await userToken(o.id);
    this.stranger = await userToken(s.id);
    this.core = await serveCore();

    this.chat = await chatServer();
    this.product = new ProductApi();
    await this.product.start();

    // the box: bound to the project with a checkout, online, confining a chat session
    const deviceId = await createTestDevice(o.id);
    await bindTestRunner(this.projectId, deviceId);
    await db.execute(sql`UPDATE runners SET last_seen_at = now() WHERE device_id = ${deviceId}`);
    await db.execute(
      sql`UPDATE devices SET capabilities = '{"followUpCredential": true, "turnCredential": true, "confinedChatNetwork": true}'::jsonb WHERE id = ${deviceId}`,
    );
    this.box = new SessionBox(this.core.base, await boxToken(o.id, deviceId), deviceId);
    await this.box.connect();
  }

  /** The two connections and their bindings, as a project admin makes them (the setup in the proposal). */
  async bind(
    support: Record<string, unknown> = { product: 'Catalog, the shop back office' },
  ): Promise<void> {
    const rc = await api(this.owner, 'POST', '/api/integration-connections', {
      provider: 'rocketchat',
      displayName: 'Support bot',
      config: { serverUrl: this.chat.serverUrl },
      secrets: { authToken: this.chat.bot.authToken, userId: this.chat.bot.userId },
      bindings: [
        {
          projectId: this.projectId,
          role: 'service',
          target: { provider: 'rocketchat', rids: [this.chat.rid], support },
        },
      ],
    });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    this.rcConnectionId = String((rc.body.connection as { id: string }).id);
    const apiConn = await api(this.owner, 'POST', '/api/integration-connections', {
      provider: 'support-api',
      displayName: 'Catalog API',
      config: { baseUrl: this.product.base },
      secrets: { headers: { Authorization: `Bearer ${ProductApi.SECRET}` } },
      bindings: [
        {
          projectId: this.projectId,
          role: 'service',
          target: { provider: 'support-api', tools: SUPPORT_TOOLS },
        },
      ],
    });
    expect(apiConn.status, JSON.stringify(apiConn.body)).toBe(201);
    this.apiConnectionId = String((apiConn.body.connection as { id: string }).id);
    await settleOutbox();
    const { startRocketChatManager } = await import('../../src/integrations/rocketchat/index.js');
    await startRocketChatManager();
  }

  async rooms(): Promise<Record<string, unknown>[]> {
    const got = await api(this.owner, 'GET', `/api/projects/${this.projectId}/support/rooms`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    return got.body.rooms as Record<string, unknown>[];
  }

  async actions(roomId: string): Promise<Record<string, unknown>[]> {
    const got = await api(
      this.owner,
      'GET',
      `/api/projects/${this.projectId}/support/rooms/${roomId}/actions`,
    );
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    return got.body.actions as Record<string, unknown>[];
  }

  /** The bot's lines, waited for until `pred` holds over them. */
  async untilLines(pred: (lines: BotLine[]) => boolean, ms = 30_000): Promise<BotLine[]> {
    await expect
      .poll(async () => pred(await this.chat.botLines()), { timeout: ms, interval: 50 })
      .toBe(true);
    return this.chat.botLines();
  }

  /** What a how-to answer is found in: a knowledge page and a published OpenAPI operation (BC-2). */
  async knowledge(): Promise<void> {
    await this.seedKnowledge(
      'catalog-export',
      'Exporting the catalog',
      'To export the catalog products, open Products, choose Export, then pick CSV. The file holds every product with its price and stock.',
    );
    await this.seedOpenApi('catalog-api', '1.4.0', {
      openapi: '3.0.3',
      info: { title: 'Catalog', version: '1.4.0' },
      paths: {
        '/products/export': {
          get: { summary: 'Export catalog products as CSV', operationId: 'exportProducts' },
        },
      },
    });
  }

  async seedKnowledge(slug: string, title: string, body: string): Promise<void> {
    const put = await api(this.owner, 'PUT', `/api/projects/${this.projectId}/knowledge/${slug}`, {
      title,
      body,
      kind: 'guide',
    });
    expect(put.status, JSON.stringify(put.body)).toBeLessThan(300);
  }

  /** A current OpenAPI contract the project publishes, as a recorded, approved version. */
  async seedOpenApi(slug: string, version: string, doc: unknown): Promise<void> {
    const content = JSON.stringify(doc);
    const sha = createHash('sha256').update(content).digest('hex');
    await db.execute(sql`
      INSERT INTO contract_artifacts (sha256, content, byte_length) VALUES (${sha}, ${content}, ${Buffer.byteLength(content)})
      ON CONFLICT DO NOTHING
    `);
    const document = {
      $schema: 'https://forge.sidcorp.co/schemas/contract-version-v1.json',
      version: 1,
      contract: `x/${slug}`,
      contractVersion: version,
      previous: null,
      artifact: null,
      observedAt: new Date().toISOString(),
      diff: { tool: 'none', classification: 'initial', changes: [] },
    };
    await db.execute(sql`
      INSERT INTO contract_versions
        (provider_project_id, contract_slug, version, recorded_at, contract_type, document, classification,
         approval, decided_as, decided_at, artifact_sha256)
      VALUES (${this.projectId}, ${slug}, ${version}, now(), 'openapi', ${JSON.stringify(document)}::jsonb, 'initial',
              'approved', 'before-approval', now(), ${sha})
    `);
  }

  async stop(): Promise<void> {
    const { stopRocketChatManager } = await import('../../src/integrations/rocketchat/index.js');
    await stopRocketChatManager();
    this.box?.close();
    await this.chat?.close();
    await this.product?.close();
    if (this.core) await stopCore(this.core);
    await closeWorld();
    const failed = this.box?.errors ?? [];
    if (failed.length) {
      throw new AggregateError(failed, `the session box failed ${failed.length} turn(s)`);
    }
  }
}
