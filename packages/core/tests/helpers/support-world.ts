// The world a Rocket.Chat support group (REQ-75) is driven in: core served over a real socket with
// the Rocket.Chat connection manager running, a chat server the bot is a member of, a product API
// the project grants tools on, and a stand-in box that plays the session's Claude Code — it hears
// each turn as the runner does and acts only through `forge_support` on /mcp under the token core
// handed the turn, then reports the turn done as the runner does.
//
// The chat server is `support-chat-server.ts`'s: a stand-in by default, a real Rocket.Chat on demand.

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { declareQueue } from '../../src/queue/boss.js';
import { INTEGRATIONS_QUEUE_NAME } from '../../src/queue/names.js';
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
import { SessionBox, SUPPORT_BOX_CAPS } from './support-session-box.js';

export type { BotLine, ChatServer, Member } from './support-chat-server.js';
export { ProductApi, SUPPORT_TOOLS } from './support-product-api.js';
export {
  messagesOf,
  SessionBox,
  SUPPORT_BOX_CAPS,
  type Turn,
  type TurnMessage,
} from './support-session-box.js';

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
  /**
   * Each turn core could not hand to the box (`support/dispatch.ts:deliverWaiting`), with why. Such a
   * failure arms the room's 30 s back-off, which this world never waits out: a later message then
   * reads as a delivery timeout. `stop` throws them, so the run names what failed.
   */
  readonly undelivered: { at: string; roomId: unknown; why: string }[] = [];

  async start(): Promise<void> {
    const { logger } = await import('../../src/lib/logger.js');
    const logError = logger.error.bind(logger);
    vi.spyOn(logger, 'error').mockImplementation(((
      obj: unknown,
      msg?: unknown,
      ...rest: unknown[]
    ) => {
      if (msg === 'support: the turn did not reach its box') {
        const { err, roomId } = (obj ?? {}) as { err?: unknown; roomId?: unknown };
        const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.undelivered.push({ at: new Date().toISOString(), roomId, why });
      }
      return (logError as (...a: unknown[]) => void)(obj, msg, ...rest);
    }) as typeof logger.error);
    await startQueue();
    // a confirmed deploy queues its Coolify dispatch here; with no worker it waits to be read
    await declareQueue(INTEGRATIONS_QUEUE_NAME);
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
      sql`UPDATE devices SET capabilities = ${SUPPORT_BOX_CAPS}::jsonb WHERE id = ${deviceId}`,
    );
    this.box = new SessionBox(this.core.base, await boxToken(o.id, deviceId), deviceId);
    await this.box.connect();
  }

  /** The two connections and their bindings, as a project admin makes them (the setup in the proposal). */
  async bind(
    support: Record<string, unknown> = {
      product: 'Catalog, the shop back office',
      grants: { abilities: ['read_checkout', 'file_items'] },
    },
  ): Promise<void> {
    await this.bindTarget({ rids: [this.chat.rid], support });
  }

  /**
   * The two connections, the Rocket.Chat binding carrying `target` as given (a channel agent's
   * `agent` block over both groups, REQ-77), as a project admin makes them.
   */
  async bindTarget(target: Record<string, unknown>): Promise<void> {
    const rc = await api(this.owner, 'POST', '/api/integration-connections', {
      provider: 'rocketchat',
      displayName: 'Support bot',
      config: { serverUrl: this.chat.serverUrl },
      secrets: { authToken: this.chat.bot.authToken, userId: this.chat.bot.userId },
      bindings: [
        {
          projectId: this.projectId,
          role: 'service',
          target: { provider: 'rocketchat', ...target },
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
   * Re-declare the room's `support` block through the binding door, as a project admin changes it
   * in project settings (REQ-75 r5 BC-25): the answer, refused or held.
   */
  async regrant(
    support: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.retarget({ support });
  }

  /** Re-declare the Rocket.Chat binding's target with `patch` merged over it, through the binding door. */
  async retarget(
    patch: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const [b] = await rows<{ id: string }>(
      sql`SELECT id FROM integration_bindings WHERE connection_id = ${this.rcConnectionId}::uuid`,
    );
    const path = `/api/projects/${this.projectId}/bindings/${String(b?.id)}`;
    const got = await api(this.owner, 'GET', path);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const document = got.body.document as { target: Record<string, unknown> };
    return api(this.owner, 'PUT', path, {
      baseRevision: got.body.revision,
      document: { ...document, target: { ...document.target, ...patch } },
    });
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
    const failed: unknown[] = [
      ...(this.box?.errors ?? []),
      ...this.undelivered.map(
        (u) =>
          new Error(`a turn did not reach the box at ${u.at} (room ${String(u.roomId)}): ${u.why}`),
      ),
    ];
    if (failed.length) {
      throw new AggregateError(
        failed,
        `the session box failed, or was never handed, ${failed.length} turn(s)`,
      );
    }
  }
}
