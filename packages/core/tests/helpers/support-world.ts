// The world a Rocket.Chat support group (REQ-75) is driven in: core served over a real socket with
// the Rocket.Chat connection manager running, a chat server the bot is a member of, a product API
// the project grants tools on, and a stand-in box that plays the session's Claude Code — it hears
// each turn as the runner does and acts only through `forge_support` on /mcp under the token core
// handed the turn, then reports the turn done as the runner does.
//
// The chat server is `support-chat-server.ts`'s: a stand-in by default, a real Rocket.Chat on demand.

import { createHash } from 'node:crypto';
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
  rows,
} from './factories.js';
import { boxToken, type Served, serveCore, stopCore } from './preview-world.js';
import { type BotLine, type ChatServer, chatServer } from './support-chat-server.js';
import { ProductApi, SUPPORT_TOOLS } from './support-product-api.js';

export type { BotLine, ChatServer, Member } from './support-chat-server.js';
export { ProductApi, SUPPORT_TOOLS } from './support-product-api.js';

/** One message of a turn as the session reads it: its thread, its writer, and the words. */
export interface TurnMessage {
  thread: string;
  from: { id: string; name: string | null } | 'forge';
  text: string;
}

export interface Turn {
  /** `session.send`: messages core wrote into the running turn (the resident's stdin). */
  event: 'agent:start' | 'agent:send' | 'session.send';
  sessionId: string;
  token: string;
  text: string;
  messages: TurnMessage[];
  claudeSessionId: string | null;
  /** The frame told the box to keep its Claude Code process resident between turns. */
  keepResident: boolean;
  /** A warm-up: the session is spawned and briefed with no member message to answer. */
  warmUp: boolean;
  /** When the box heard it. */
  at: number;
}

/** A turn the box is running, and what core wrote into it while it ran. */
interface Running {
  turn: Turn;
  injected: { seq: number; work: Promise<void> }[];
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
 * test scripts, and reports the turn done with the Claude session id a resume reads. A `session.send`
 * while a turn runs is written into it, as the runner writes the resident's stdin: acked delivered,
 * handed to the model as messages of that turn, and reported applied when the turn completes; with
 * no turn running it is acked gone, as the runner refuses it. A warm-up turn is answered without the
 * model, as Claude Code answers "ready".
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
  private readonly running = new Map<string, Running>();

  /** No turn of any session is running on this box. */
  idle(): boolean {
    return this.running.size === 0;
  }

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
      // a turn still calling core when the world stops fails on a closed core: that is the stop
      const failed = (err: unknown) => {
        if (!this.closed) this.errors.push(err);
      };
      if (frame.event === 'agent:start' || frame.event === 'agent:send') {
        this.run(frame).catch(failed);
      } else if (frame.event === 'session.send') {
        this.inject(frame.data).catch(failed);
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
    const messages = messagesOf(text);
    const turn: Turn = {
      event: frame.event as Turn['event'],
      sessionId: String(d.sessionId),
      token: String(d.forgeToken ?? ''),
      text,
      messages,
      claudeSessionId: (d.claudeSessionId as string | undefined) ?? null,
      keepResident: d.keepResident === true,
      warmUp: messages.length === 0 && text.includes('reply with the single word: ready'),
      at: Date.now(),
    };
    this.turns.push(turn);
    this.running.set(turn.sessionId, { turn, injected: [] });
    if (!turn.warmUp) await this.model(turn, (args) => this.tool(turn.token, args));
    if (!this.finishTurns && !turn.warmUp) return;
    await this.finish(
      turn.sessionId,
      turn.claudeSessionId ?? `claude-${turn.sessionId.slice(0, 8)}`,
    );
  }

  /** Messages core wrote into the session's running turn, or refused where none runs. */
  private async inject(d: Record<string, unknown>): Promise<void> {
    const sessionId = String(d.sessionId);
    const seq = Number(d.seq);
    const running = this.running.get(sessionId);
    if (!running) {
      await this.post(`/api/agent-sessions/${sessionId}/inbox/${seq}/ack`, { outcome: 'gone' });
      return;
    }
    await this.post(`/api/agent-sessions/${sessionId}/inbox/${seq}/ack`, {
      outcome: 'delivered',
    });
    const text = String(d.body ?? '');
    const turn: Turn = {
      ...running.turn,
      event: 'session.send',
      text,
      messages: messagesOf(text),
      warmUp: false,
      at: Date.now(),
    };
    this.turns.push(turn);
    const work = this.model(turn, (args) => this.tool(turn.token, args));
    running.injected.push({ seq, work });
    await work;
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`the box's ${path} answered ${res.status} ${await res.text()}`);
  }

  /**
   * The turn ends as the runner reports it: once what was written into it is answered, completed
   * with each write applied, the process left resident and Claude's session id kept; or failed.
   */
  async finish(sessionId: string, claudeSessionId: string): Promise<void> {
    const running = this.running.get(sessionId);
    for (const i of running?.injected ?? []) await i.work;
    this.running.delete(sessionId);
    this.turnSeq += 1;
    const patch = async (body: unknown) => {
      const res = await fetch(`${this.base}/api/agent-sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`the box could not end the turn: ${res.status} ${await res.text()}`);
    };
    if (this.turnEnd === 'failed') {
      await patch({ status: 'failed' });
      return;
    }
    for (const i of running?.injected ?? []) {
      await this.post(`/api/agent-sessions/${sessionId}/inbox/${i.seq}/applied`, {
        turn: this.turnSeq,
      });
    }
    await patch({ runtimeState: 'awaiting_input' });
    await patch({ status: 'completed', claudeSessionId });
  }

  /** The turns that carried member messages: what the session was asked, not its warm-ups. */
  asked(): Turn[] {
    return this.turns.filter((t) => !t.warmUp);
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
    await this.settleWarm();
  }

  /**
   * Binding warms the session, and the two bindings' changes can each start a warm-up turn: wait
   * until every one has ended (a tools re-tell owed to a busy session paid as the sweep pays it), so
   * a test's first message meets one idle, resident session and not a warm-up still running.
   */
  async settleWarm(ms = 20_000): Promise<void> {
    const { warmColdRooms } = await import('../../src/support/index.js');
    const until = Date.now() + ms;
    let quiet = 0;
    while (quiet < 3) {
      if (Date.now() > until) throw new Error(`the room's session was still warming after ${ms}ms`);
      await settleOutbox();
      await warmColdRooms();
      const [room] = await this.rooms();
      const settled =
        room?.resident === true && room.sessionStatus === 'completed' && this.box.idle();
      quiet = settled ? quiet + 1 : 0;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** The project's newest filing, which a group member made: handed no status link (BC-14). */
  async lastGroupFiling(): Promise<{ kind: string; body: string; fb_seq: number }> {
    const [fb] = await rows<{
      id: string;
      kind: string;
      channel: string;
      body: string;
      fb_seq: number;
      status_token_hash: string | null;
    }>(sql`
      SELECT f.id, f.kind, r.channel, f.body, f.fb_seq, r.status_token_hash FROM feedback f
        JOIN feedback_external_reporters r ON r.feedback_id = f.id
       WHERE f.project_id = ${this.projectId}::uuid ORDER BY f.created_at DESC LIMIT 1`);
    if (!fb) throw new Error('no filing in the project');
    // no token exists that anyone in the group could open, and the schema refuses one
    expect(fb).toMatchObject({ channel: 'rocketchat', status_token_hash: null });
    await expect(
      db.execute(sql`UPDATE feedback_external_reporters SET status_token_hash = ${'a'.repeat(64)}
                      WHERE feedback_id = ${fb.id}::uuid`),
    ).rejects.toMatchObject({
      cause: { constraint_name: 'feedback_external_reporters_status_link_chk' },
    });
    return fb;
  }

  /** The room's session is warm: its warm-up turn ran and the process stays resident. */
  async untilWarm(): Promise<void> {
    await expect
      .poll(async () => (await this.rooms())[0]?.resident === true && this.box.turns.length > 0, {
        timeout: 20_000,
        interval: 50,
      })
      .toBe(true);
    await expect
      .poll(async () => (await this.rooms())[0]?.sessionStatus, { timeout: 20_000 })
      .toBe('completed');
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
