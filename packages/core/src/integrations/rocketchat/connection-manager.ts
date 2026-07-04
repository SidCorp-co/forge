/**
 * ISS-604 (P2c + P2d) — Rocket.Chat bot-user connection manager.
 *
 * Loads active `rocketchat` integration connections, opens ONE long-lived DDP
 * bot-user socket per connection (single-owner via a pg advisory lock so a
 * scaled-out core never double-answers), and routes inbound room messages
 * through the read-only chat engine, replying in the same room.
 *
 * Lane A (conversational) only. Trigger-gated to @-mentions of the bot; the
 * bot's own messages / system / edits are ignored (no reply loops).
 */

import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { runExternalChatTurn } from '../../chat/external-chat.js';
import { buildExternalMcpToolsets } from '../../chat/tools/external-mcp.js';
import { mergeToolsets } from '../../chat/tools/mcp-adapter.js';
import { buildChatToolContext } from '../../chat/tools/principal.js';
import { buildProjectToolset } from '../../chat/tools/registry.js';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { integrationConnections, organizations, projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { decryptConnectionSecrets, listBindingsForConnection } from '../store.js';
import { buildConversationContext, buildRocketChatHistoryToolset } from './context.js';
import { RocketChatDdpClient, type RocketChatIncomingMessage } from './ddp-client.js';
import { createSeenTracker, decideHandling } from './inbound-gate.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

/** ISS-609 (piece B) — the Forge-assistant persona for in-channel chat.
 *  `systemPromptOverride` on the project still wins over this. */
export function rocketChatPersona(projectName: string, authorUsername?: string): string {
  return [
    `You are the working assistant for project "${projectName}", answering inside the team's Rocket.Chat channel. You OWN the requests addressed to you — investigate and act with your tools; never hand the task back to the humans.`,
    ...(authorUsername
      ? [
          `- The message you are answering was sent by user @${authorUsername}. When they say "tôi/mình/my/me", they mean @${authorUsername} — use that username when filtering tasks/items by person.`, // i18n-allow: quotes the Vietnamese first-person pronouns the prompt must resolve
        ]
      : []),
    '- Read the conversation context first; if it references older discussion, call rocketchat_history before concluding.',
    '- INVESTIGATE before answering: use the forge_* tools instead of guessing. Search issues with SHORT keyword fragments (2-4 words) and retry with different fragments if empty — long exact titles rarely match. Cross-check forge_memory.search and forge_knowledge for project context, and read issue comments when a discussion references one.',
    "- Tools prefixed with an external system name (e.g. `Sidcorp-Hub__…`) query that system directly. The team's day-to-day tasks usually live THERE, not in Forge. MANDATORY for ANY question about tasks/work items — a specific task, someone's pending/assigned tasks, counts, statuses: (1) call the external schema tool (e.g. `Sidcorp-Hub__graphql_schema`) to learn the available queries and filters, (2) then query (e.g. `Sidcorp-Hub__graphql_query`) filtering by the keywords/username involved. NEVER claim \"the tools cannot do this\" or ask the user for an ID before you have introspected the schema and tried a query. Schemas often expose `my*` queries (e.g. `myTasks`) scoped to the connection identity — they need NO user id; prefer them for the requester's own items, and never ask the user for an internal ID.",
    '- ACT, do not delegate: when something needs recording or follow-up, DO it yourself — create the issue (it always enters as `draft`; a human later moves it to `open`) or add a comment via forge_comments, then report what you did. Only mention a person when the action truly requires something outside your tools (a credential, a manual test, a business decision) — and even then, first do every part you CAN do and state exactly what remains and why.',
    '- Never reply with only "ask X to do Y" or "please provide more info" if a tool call could find the answer or capture the work as a draft issue.',
    '- Your reply is the ONLY message the user receives — there is no follow-up turn. NEVER announce what you are about to do ("mình sẽ truy vấn…", "đang kiểm tra…"): CALL the tool now instead, and reply only when you have the result (or a concrete failure to report).', // i18n-allow: quotes the Vietnamese announcement phrases being banned
    '- For a broad request ("check the project", "tình hình sao rồi"), do not just ask what to check — produce a brief status overview from the tools (e.g. the requester\'s open task count + any notable items from the external hub and forge issues), then offer to drill into specifics.', // i18n-allow: quotes a Vietnamese broad-request example
    '- Reply concisely in Vietnamese (switch language only if the user clearly writes another one). Plain chat text, no markdown headers.',
  ].join('\n');
}

const LOCK_NAMESPACE = 'forge:rocketchat';
const MAX_BACKOFF_MS = 30_000;
/** Delay before re-acquiring after the advisory-lock connection dies — gives
 *  the DB a beat to come back and lets another instance win the lock first. */
const LOCK_REACQUIRE_DELAY_MS = 5000;
/** pg NOTIFY channel fanning connection/binding CRUD out to EVERY core
 *  instance — the advisory-lock owner may not be the process that served the
 *  HTTP request. */
const RELOAD_CHANNEL = 'forge_rocketchat_reload';
const LISTEN_RETRY_MS = 5000;
/** Rocket.Chat rejects messages over `Message_MaxAllowedSize` (default 5000)
 *  outright — the user would get silence. Truncate below that. */
const MAX_REPLY_CHARS = 4500;

const FALLBACK_ERROR_REPLY =
  'Xin lỗi, hệ thống model đang quá tải hoặc gặp sự cố — bạn thử lại sau ít phút nhé.'; // i18n-allow: user-facing channel reply

function clipReply(reply: string): string {
  return reply.length > MAX_REPLY_CHARS ? `${reply.slice(0, MAX_REPLY_CHARS)}… [truncated]` : reply;
}

interface Route {
  rid: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  /** Forge user the chat tools run as (project's org owner). */
  principalUserId: string;
}

interface ActiveConnection {
  client?: RocketChatDdpClient;
  lockClient: pg.Client;
  botUserId: string;
  serverUrl: string;
  authToken: string;
  routes: Map<string, Route>;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout | undefined;
  closing: boolean;
}

class RocketChatConnectionManager {
  private readonly conns = new Map<string, ActiveConnection>();
  /** rid → chat session id, so a room keeps one multi-turn conversation. */
  private readonly sessionByRid = new Map<string, string>();
  /** Duplicate-delivery guard — RC re-emits messages after URL-preview
   *  enrichment; without this one mention yields two racing replies. */
  private readonly seenMessage = createSeenTracker();
  private started = false;
  private listenClient?: pg.Client | undefined;
  private listenRetryTimer?: NodeJS.Timeout | undefined;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Listen even with zero connections — the first-ever connect arrives as a
    // NOTIFY from whichever instance served the HTTP request.
    this.startReloadListener();
    const rows = await db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.provider, 'rocketchat'),
          eq(integrationConnections.active, true),
        ),
      );
    if (rows.length === 0) {
      logger.info('rocketchat: no active connections; manager idle');
      return;
    }
    for (const conn of rows) {
      await this.acquire(conn.id).catch((err) =>
        logger.error({ err, connectionId: conn.id }, 'rocketchat: acquire failed'),
      );
    }
  }

  private async acquire(connectionId: string): Promise<void> {
    const [conn] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    if (!conn || !conn.active) return;

    // Single-owner: hold a session advisory lock on a dedicated connection.
    const lockClient = new pg.Client({ connectionString: env.DATABASE_URL });
    await lockClient.connect();
    const res = await lockClient.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtext($1), hashtext($2)) as ok',
      [LOCK_NAMESPACE, connectionId],
    );
    if (!res.rows[0]?.ok) {
      await lockClient.end();
      logger.info({ connectionId }, 'rocketchat: another process owns this connection; skipping');
      return;
    }

    // A dead lock connection means the advisory lock is GONE (session-scoped)
    // and, without a listener, pg.Client's 'error' event would crash the
    // process. Tear down and retry — another instance may own it by then.
    lockClient.on('error', (err) => {
      logger.warn({ err, connectionId }, 'rocketchat: advisory-lock connection lost');
      const ac = this.conns.get(connectionId);
      if (!ac || ac.closing) return;
      void this.teardown(connectionId).then(() => {
        setTimeout(() => {
          void this.acquire(connectionId).catch((e) =>
            logger.error({ err: e, connectionId }, 'rocketchat: re-acquire after lock loss failed'),
          );
        }, LOCK_REACQUIRE_DELAY_MS).unref?.();
      });
    });

    const secrets = decryptConnectionSecrets<RocketChatSecrets>(conn);
    const config = (conn.config ?? {}) as RocketChatConfig;
    if (!config.serverUrl || !secrets.authToken || !secrets.userId) {
      logger.error({ connectionId }, 'rocketchat: connection missing serverUrl/credentials');
      await lockClient.end();
      return;
    }

    const routes = await this.buildRoutes(connectionId);
    const active: ActiveConnection = {
      lockClient,
      botUserId: secrets.userId,
      serverUrl: config.serverUrl,
      authToken: secrets.authToken,
      routes,
      reconnectAttempt: 0,
      closing: false,
    };
    this.conns.set(connectionId, active);
    logger.info(
      { connectionId, rooms: [...routes.keys()] },
      'rocketchat: connection acquired, dialing',
    );
    await this.dial(connectionId);
  }

  private async buildRoutes(connectionId: string): Promise<Map<string, Route>> {
    const routes = new Map<string, Route>();
    const bindings = await listBindingsForConnection(connectionId);
    for (const { binding: b } of bindings) {
      if (!b.active) continue;
      const rid = (b.config as { rid?: string } | null)?.rid;
      if (!rid) continue;
      const [proj] = await db
        .select({ slug: projects.slug, name: projects.name, orgId: projects.orgId })
        .from(projects)
        .where(eq(projects.id, b.projectId))
        .limit(1);
      if (!proj) continue;
      const [org] = await db
        .select({ createdBy: organizations.createdBy })
        .from(organizations)
        .where(eq(organizations.id, proj.orgId))
        .limit(1);
      if (!org?.createdBy) continue;
      routes.set(rid, {
        rid,
        projectId: b.projectId,
        projectSlug: proj.slug,
        projectName: proj.name,
        principalUserId: org.createdBy,
      });
    }
    return routes;
  }

  private async dial(connectionId: string): Promise<void> {
    const ac = this.conns.get(connectionId);
    if (!ac || ac.closing) return;
    // A redial replaces the client; close the old socket and gate callbacks on
    // still being current, so a slow-dying socket can't trigger a second dial
    // (two live sockets = duplicate deliveries).
    try {
      ac.client?.close();
    } catch {
      // ignore
    }
    const isCurrent = () => this.conns.get(connectionId)?.client === client;
    const client: RocketChatDdpClient = new RocketChatDdpClient({
      serverUrl: ac.serverUrl,
      authToken: ac.authToken,
      userId: ac.botUserId,
      onMessage: (m) => {
        if (isCurrent()) this.onMessage(connectionId, m);
      },
      onClose: () => {
        if (isCurrent()) this.scheduleReconnect(connectionId);
      },
      onError: (e) => logger.warn({ err: e, connectionId }, 'rocketchat: DDP error'),
    });
    ac.client = client;
    try {
      await client.connect();
      ac.reconnectAttempt = 0;
      logger.info({ connectionId }, 'rocketchat: DDP live');
    } catch (err) {
      logger.warn({ err, connectionId }, 'rocketchat: DDP connect failed');
      this.scheduleReconnect(connectionId);
    }
  }

  private scheduleReconnect(connectionId: string): void {
    const ac = this.conns.get(connectionId);
    if (!ac || ac.closing || ac.reconnectTimer) return;
    ac.reconnectAttempt += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** ac.reconnectAttempt);
    ac.reconnectTimer = setTimeout(() => {
      const cur = this.conns.get(connectionId);
      if (cur) cur.reconnectTimer = undefined;
      void this.dial(connectionId);
    }, delay);
  }

  private onMessage(connectionId: string, m: RocketChatIncomingMessage): void {
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    const decision = decideHandling(m, ac.botUserId);
    if (!decision.handle) return;
    if (this.seenMessage(m.id)) return; // enrichment re-emit / reconnect replay
    const route = ac.routes.get(m.rid);
    if (!route) {
      logger.debug({ connectionId, rid: m.rid }, 'rocketchat: no binding for room; ignoring');
      return;
    }
    void this.handle(ac, route, m).catch((err) =>
      logger.error({ err, connectionId, rid: m.rid }, 'rocketchat: message handling failed'),
    );
  }

  private async handle(
    ac: ActiveConnection,
    route: Route,
    m: RocketChatIncomingMessage,
  ): Promise<void> {
    const restAuth = { serverUrl: ac.serverUrl, authToken: ac.authToken, userId: ac.botUserId };
    // ISS-609 (piece A) — seed the turn with the recent room discussion (+ full
    // thread when the mention is threaded); deeper recall stays agentic via the
    // bounded rocketchat_history tool merged into the forge_* toolset. The
    // project's configured external MCP servers (task hub, …) are bridged in
    // fresh each turn so the bot investigates the same systems the pipeline
    // agents get injected.
    const [conversationContext, agentConfigRow] = await Promise.all([
      buildConversationContext(restAuth, {
        rid: m.rid,
        tmid: m.tmid,
        excludeMessageId: m.id,
      }),
      db
        .select({ agentConfig: projects.agentConfig })
        .from(projects)
        .where(eq(projects.id, route.projectId))
        .limit(1),
    ]);
    const external = await buildExternalMcpToolsets(agentConfigRow[0]?.agentConfig);
    let reply: string;
    try {
      const tools = mergeToolsets(
        buildProjectToolset(
          buildChatToolContext({
            userId: route.principalUserId,
            projectId: route.projectId,
            projectSlug: route.projectSlug,
          }),
        ),
        buildRocketChatHistoryToolset(restAuth, m.rid),
        ...external.toolsets,
      );
      const result = await runExternalChatTurn({
        projectId: route.projectId,
        source: 'rocketchat',
        sessionId: this.sessionByRid.get(m.rid),
        message: m.text,
        tools,
        userKey: m.userId,
        persona: rocketChatPersona(route.projectName, m.username),
        conversationContext,
      });
      this.sessionByRid.set(m.rid, result.sessionId);
      reply =
        result.reply.trim() ||
        (result.terminal === 'error' ? FALLBACK_ERROR_REPLY : "Sorry, I couldn't produce a reply.");
    } catch (err) {
      // The mention was seen — never leave the user in silence. Drop the room's
      // session pointer so a poisoned session (e.g. deleted row) can't wedge
      // every future turn; the next mention starts a fresh conversation.
      logger.error({ err, rid: m.rid, projectId: route.projectId }, 'rocketchat: chat turn threw');
      this.sessionByRid.delete(m.rid);
      reply = FALLBACK_ERROR_REPLY;
    } finally {
      await external.dispose();
    }
    // A threaded mention gets its reply in the same thread.
    await ac.client?.sendMessage(m.rid, clipReply(reply), m.tmid);
  }

  private async teardown(connectionId: string): Promise<void> {
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    ac.closing = true;
    if (ac.reconnectTimer) clearTimeout(ac.reconnectTimer);
    try {
      ac.client?.close();
    } catch {
      // ignore
    }
    try {
      await ac.lockClient.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', [
        LOCK_NAMESPACE,
        connectionId,
      ]);
      await ac.lockClient.end();
    } catch {
      // ignore
    }
    this.conns.delete(connectionId);
  }

  /**
   * ISS-609 — config hot-reload: connection/binding CRUD (web UI / REST)
   * applies live without a core restart. Tears the socket down (if we own it)
   * and re-acquires; `acquire` no-ops when the connection is now inactive,
   * deleted, or owned by another process. Reached via the pg NOTIFY listener
   * so it runs on every instance, not just the one that served the request.
   */
  async reload(connectionId: string): Promise<void> {
    this.started = true; // an idle manager (no connections at boot) can start owning one now
    await this.teardown(connectionId);
    await this.acquire(connectionId).catch((err) =>
      logger.error({ err, connectionId }, 'rocketchat: reload failed'),
    );
  }

  /** Dedicated LISTEN connection for {@link RELOAD_CHANNEL}; self-heals with a
   *  flat retry so a DB blip can't permanently sever hot-reload. */
  private startReloadListener(): void {
    if (this.listenClient) return;
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    this.listenClient = client;
    client.on('error', (err) => {
      logger.warn({ err }, 'rocketchat: reload listener connection lost');
      this.restartReloadListener(client);
    });
    client.on('notification', (n) => {
      if (n.channel !== RELOAD_CHANNEL || !n.payload) return;
      void this.reload(n.payload);
    });
    client
      .connect()
      .then(() => client.query(`listen ${RELOAD_CHANNEL}`))
      .then(() => logger.info('rocketchat: reload listener live'))
      .catch((err) => {
        logger.warn({ err }, 'rocketchat: reload listener failed to connect');
        this.restartReloadListener(client);
      });
  }

  private restartReloadListener(failed: pg.Client): void {
    if (this.listenClient !== failed) return; // stale event from a replaced client
    this.listenClient = undefined;
    void failed.end().catch(() => {});
    if (!this.started || this.listenRetryTimer) return;
    this.listenRetryTimer = setTimeout(() => {
      this.listenRetryTimer = undefined;
      if (this.started) this.startReloadListener();
    }, LISTEN_RETRY_MS);
    this.listenRetryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.listenRetryTimer) clearTimeout(this.listenRetryTimer);
    this.listenRetryTimer = undefined;
    const listen = this.listenClient;
    this.listenClient = undefined;
    if (listen) await listen.end().catch(() => {});
    for (const connectionId of [...this.conns.keys()]) {
      await this.teardown(connectionId);
    }
  }
}

export const rocketChatManager = new RocketChatConnectionManager();
export const startRocketChatManager = (): Promise<void> => rocketChatManager.start();
export const stopRocketChatManager = (): Promise<void> => rocketChatManager.stop();

/**
 * Fan a connection/binding CRUD out to every core instance via pg NOTIFY —
 * the advisory-lock owner may not be the process that served the HTTP request.
 * The serving instance receives its own notification through the listener.
 */
export async function requestRocketChatReload(connectionId: string): Promise<void> {
  await db.execute(sql`select pg_notify(${RELOAD_CHANNEL}, ${connectionId})`);
}
