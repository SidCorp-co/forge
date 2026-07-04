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

import { and, eq } from 'drizzle-orm';
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
    '- Tools prefixed with an external system name (e.g. `Sidcorp-Hub__…`) query that system directly. The team\'s day-to-day tasks usually live THERE, not in Forge. MANDATORY for ANY question about tasks/work items — a specific task, someone\'s pending/assigned tasks, counts, statuses: (1) call the external schema tool (e.g. `Sidcorp-Hub__graphql_schema`) to learn the available queries and filters, (2) then query (e.g. `Sidcorp-Hub__graphql_query`) filtering by the keywords/username involved. NEVER claim "the tools cannot do this" or ask the user for an ID before you have introspected the schema and tried a query.',
    '- ACT, do not delegate: when something needs recording or follow-up, DO it yourself — create the issue (it always enters as `draft`; a human later moves it to `open`) or add a comment via forge_comments, then report what you did. Only mention a person when the action truly requires something outside your tools (a credential, a manual test, a business decision) — and even then, first do every part you CAN do and state exactly what remains and why.',
    '- Never reply with only "ask X to do Y" or "please provide more info" if a tool call could find the answer or capture the work as a draft issue.',
    '- Reply concisely in Vietnamese (switch language only if the user clearly writes another one). Plain chat text, no markdown headers.',
  ].join('\n');
}

const LOCK_NAMESPACE = 'forge:rocketchat';
const MAX_BACKOFF_MS = 30_000;

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

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
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
    const client = new RocketChatDdpClient({
      serverUrl: ac.serverUrl,
      authToken: ac.authToken,
      userId: ac.botUserId,
      onMessage: (m) => this.onMessage(connectionId, m),
      onClose: () => this.scheduleReconnect(connectionId),
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
      const reply =
        result.reply.trim() ||
        (result.terminal === 'error'
          ? 'Xin lỗi, hệ thống model đang quá tải hoặc gặp sự cố — bạn thử lại sau ít phút nhé.' // i18n-allow: user-facing channel reply
          : "Sorry, I couldn't produce a reply.");
      // A threaded mention gets its reply in the same thread.
      await ac.client?.sendMessage(m.rid, reply, m.tmid);
    } finally {
      await external.dispose();
    }
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
   * deleted, or owned by another process.
   */
  async reload(connectionId: string): Promise<void> {
    this.started = true; // an idle manager (no connections at boot) can start owning one now
    await this.teardown(connectionId);
    await this.acquire(connectionId).catch((err) =>
      logger.error({ err, connectionId }, 'rocketchat: reload failed'),
    );
  }

  async stop(): Promise<void> {
    for (const connectionId of [...this.conns.keys()]) {
      await this.teardown(connectionId);
    }
    this.started = false;
  }
}

export const rocketChatManager = new RocketChatConnectionManager();
export const startRocketChatManager = (): Promise<void> => rocketChatManager.start();
export const stopRocketChatManager = (): Promise<void> => rocketChatManager.stop();
