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

import { scrubLogText } from '@forge/observability';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import pg from 'pg';
import { runExternalChatTurn } from '../../chat/external-chat.js';
import { type ExternalMcpToolsets, buildExternalMcpToolsets } from '../../chat/tools/external-mcp.js';
import { mergeToolsets } from '../../chat/tools/mcp-adapter.js';
import { buildChatToolContext } from '../../chat/tools/principal.js';
import { buildProjectToolset } from '../../chat/tools/registry.js';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { integrationConnections, issues, organizations, projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { Sentry } from '../../observability/sentry.js';
import { decryptConnectionSecrets, listBindingsForConnection } from '../store.js';
import { buildConversationContext, buildRocketChatHistoryToolset } from './context.js';
import { RocketChatDdpClient, type RocketChatIncomingMessage } from './ddp-client.js';
import { createSeenTracker, decideHandling } from './inbound-gate.js';
import {
  detectEmptyPromise,
  extractIssueClaims,
  judgeIssueClaims,
  lintStakeholderReply,
} from './reply-guard.js';
import { fetchOwnUsername } from './rest-client.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

/** ISS-609 (piece B) — the Forge-assistant persona for in-channel chat.
 *  `systemPromptOverride` on the project still wins over this. */
export function rocketChatPersona(
  projectName: string,
  authorUsername?: string,
  opts?: {
    projectSlug?: string | undefined;
    webBaseUrl?: string | undefined;
    botName?: string | undefined;
  },
): string {
  return [
    `You are the working assistant for project "${projectName}", answering inside the team's Rocket.Chat channel. You OWN the requests addressed to you — investigate and act with your tools; never hand the task back to the humans.`,
    ...(opts?.botName
      ? [
          `- Your name in this channel is ${opts.botName}. Refer to yourself as "${opts.botName}" (e.g. "${opts.botName} đã kiểm tra…"), never as "hệ thống" or "the system".`, // i18n-allow: shows the Vietnamese self-reference style being mandated
        ]
      : []),
    ...(authorUsername
      ? [
          `- The message you are answering was sent by user @${authorUsername}. When they say "tôi/mình/my/me", they mean @${authorUsername} — use that username when filtering tasks/items by person.`, // i18n-allow: quotes the Vietnamese first-person pronouns the prompt must resolve
        ]
      : []),
    '- Read the conversation context first; if it references older discussion, call rocketchat_history before concluding.',
    '- When asked to check / analyze / verify something, LEAD your reply with what you FOUND — the entity\'s status, the key facts, and any contradiction with what the channel expects — THEN the action you took. "I created an issue" alone does not answer a check request.',
    '- When the discussion is a problem/bug report against THIS project, the reporter owes you nothing: evidence the project side can gather itself (its own logs, API/config screenshots, order ids) is the WORK — write it into the draft issue as acceptance criteria for a developer. Ask the reporter only for what only they can know (repro steps, account, time window). Never bounce the burden of proof back to the reporter.',
    '- ISSUE QUALITY CONTRACT: an issue must stand alone — a developer must be able to identify the problem just by reading the description. Title = kind + affected feature (e.g. "[Bug] Category path quá dài trên listing"). Description MUST contain the problem/request in concrete detail — what happens, where, expected vs actual — quoting the reporter where useful, plus the source links from the context: the external task/feedback link when one exists, and the chat permalink given above. Thin issues are auto-rejected by the server; if the discussion truly lacks the substance to write this, ask the reporter the missing specifics instead of filing a hollow issue.', // i18n-allow: contains a Vietnamese example issue title
    ...(opts?.webBaseUrl && opts.projectSlug
      ? [
          `- When you create or cite a Forge issue, include its web link: ${opts.webBaseUrl}/projects/${opts.projectSlug}/issues/<documentId> (forge_issues returns the documentId).`,
        ]
      : []),
    "- URLs in the context carry ids: a webhook card's link (e.g. `…/tasks?projectId=53&task=12608`) names the exact entity being discussed — extract the id from the URL and query the external system BY ID before trying any keyword search. When you cite such an entity in a reply or issue, include its URL.",
    '- INVESTIGATE before answering: use the forge_* tools instead of guessing. Search issues with SHORT keyword fragments (2-4 words) and retry with different fragments if empty — long exact titles rarely match. Cross-check forge_memory.search and forge_knowledge for project context, and read issue comments when a discussion references one.',
    "- Tools prefixed with an external system name (e.g. `Sidcorp-Hub__…`) query that system directly. The team's day-to-day tasks usually live THERE, not in Forge. MANDATORY for ANY question about tasks/work items — a specific task, someone's pending/assigned tasks, counts, statuses: (1) call the external schema tool (e.g. `Sidcorp-Hub__graphql_schema`) to learn the available queries and filters, (2) then query (e.g. `Sidcorp-Hub__graphql_query`) filtering by the keywords/username involved. NEVER claim \"the tools cannot do this\" or ask the user for an ID before you have introspected the schema and tried a query. Schemas often expose `my*` queries (e.g. `myTasks`) scoped to the connection identity — they need NO user id; prefer them for the requester's own items, and never ask the user for an internal ID.",
    '- ACT, do not delegate: when something needs recording or follow-up, DO it yourself — create the issue (it always enters as `draft`; a human later moves it to `open`) or add a comment via forge_comments, then report what you did. Only mention a person when the action truly requires something outside your tools (a credential, a manual test, a business decision) — and even then, first do every part you CAN do and state exactly what remains and why.',
    '- Never reply with only "ask X to do Y" or "please provide more info" if a tool call could find the answer or capture the work as a draft issue.',
    '- Your reply is the ONLY message the user receives — there is no follow-up turn. NEVER announce what you are about to do ("mình sẽ truy vấn…", "đang kiểm tra…"): CALL the tool now instead, and reply only when you have the result (or a concrete failure to report).', // i18n-allow: quotes the Vietnamese announcement phrases being banned
    '- For a broad request ("check the project", "tình hình sao rồi"), do not just ask what to check — produce a brief status overview from the tools (e.g. the requester\'s open task count + any notable items from the external hub and forge issues), then offer to drill into specifics.', // i18n-allow: quotes a Vietnamese broad-request example
    '- Reply concisely in Vietnamese (switch language only if the user clearly writes another one). Plain chat text, no markdown headers.',
  ].join('\n');
}

/** Web-UI base for issue links in bot replies — the first CORS origin IS the
 *  web app's origin (operators must allow it for the UI to work at all). */
const webBaseUrl = env.CORS_ORIGINS.split(',')[0]?.trim().replace(/\/+$/, '') || undefined;

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
/** Proactively redial each live DDP socket on this interval. A subscription
 *  can die WITHOUT a `nosub` (silent server-side drop) while server pings keep
 *  the link "alive", so the liveness watchdog never fires and the bot goes
 *  deaf until something closes the socket. A periodic fresh login + sub bounds
 *  that worst-case deaf window. The `nosub` handler recovers the SIGNALLED case
 *  immediately; this is the backstop for the silent one. */
const DDP_REFRESH_INTERVAL_MS = 10 * 60_000;
/** Rocket.Chat rejects messages over `Message_MaxAllowedSize` (default 5000)
 *  outright — the user would get silence. Truncate below that. */
const MAX_REPLY_CHARS = 4500;
/** Hard ceiling on the model turn(s) via the abort signal — cancels the
 *  provider fetch/SSE read so a stalled upstream terminates as an error. */
const TURN_TIMEOUT_MS = 90_000;
/** Backstop ceiling on the WHOLE handler (seed → mcp → turn → verify). The
 *  abort signal only reaches the provider; an unbounded await BEFORE the turn
 *  (a hung DB query, a stuck session load) would still wedge the handler in
 *  silence. This watchdog guarantees a fallback reply + a Sentry event (tagged
 *  with the phase it hung in) no matter where it stalls. Set above
 *  TURN_TIMEOUT_MS so a normal provider-abort resolves cleanly first. */
const HANDLE_TIMEOUT_MS = 120_000;

class HandleTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`rocketchat handle timed out after ${ms}ms`);
    this.name = 'HandleTimeoutError';
  }
}

/** Reject with {@link HandleTimeoutError} if `p` has not settled within `ms`.
 *  Does NOT cancel `p` (the caller aborts the provider separately) — it only
 *  frees the handler to send a fallback and report. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new HandleTimeoutError(ms)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Fallbacks speak AS the bot, by name — never as an anonymous "the
 *  system"/"the model". `name` is the bot's RC username, capitalized. */
const errorFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} đang quá tải hoặc gặp sự cố — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

/** Sent when even the corrective retry produced unverifiable claims — an
 *  honest non-answer beats a hallucinated one reaching the channel. */
const unverifiedFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} chưa thực hiện được yêu cầu này một cách chắc chắn (kết quả không xác minh được). Bạn nhắn lại giúp ${name} nhé.`; // i18n-allow: user-facing channel reply

const emptyFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} chưa đưa ra được câu trả lời cho yêu cầu này — bạn diễn đạt lại giúp ${name} nhé.`; // i18n-allow: user-facing channel reply

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const correctiveMessage = (problems: string[]): string =>
  `[SYSTEM CHECK — not from the user] Your previous reply cannot be sent as-is: ${problems.join('; ')}. Rewrite it now, keep only verified facts, actually CALL the tools if work is needed, cite issue ids/links only exactly as tools returned them, and reply in the user's language.`;

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
  /** Bot's RC display handle, capitalized ("Babo") — used for self-reference
   *  in fallback replies and the persona. */
  botName: string;
  serverUrl: string;
  authToken: string;
  routes: Map<string, Route>;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout | undefined;
  /** Periodic socket-refresh timer (see DDP_REFRESH_INTERVAL_MS). */
  refreshTimer?: NodeJS.Timeout | undefined;
  /** Duplicate-delivery guard — RC re-emits a message after URL-preview
   *  enrichment (one mention → two frames). MUST be PER-CONNECTION: the same
   *  bot user is subscribed on every org connection's socket via
   *  `__my_messages__`, so EVERY connection receives EVERY room's messages. A
   *  manager-global tracker let a connection with no route for a room mark the
   *  id "seen" first, so the connection that DID own the route then dropped it
   *  as a false duplicate — the intermittent "bot ignores the message" bug. */
  seenMessage: (id: string) => boolean;
  closing: boolean;
}

class RocketChatConnectionManager {
  private readonly conns = new Map<string, ActiveConnection>();
  /** rid → chat session id, so a room keeps one multi-turn conversation. */
  private readonly sessionByRid = new Map<string, string>();
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

    const restAuth = {
      serverUrl: config.serverUrl,
      authToken: secrets.authToken,
      userId: secrets.userId,
    };
    const [routes, ownUsername] = await Promise.all([
      this.buildRoutes(connectionId),
      fetchOwnUsername(restAuth),
    ]);
    const active: ActiveConnection = {
      lockClient,
      botUserId: secrets.userId,
      botName: capitalize(ownUsername ?? 'bot'),
      serverUrl: config.serverUrl,
      authToken: secrets.authToken,
      routes,
      reconnectAttempt: 0,
      seenMessage: createSeenTracker(),
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
      // Binding-tier `rids` — one binding may listen on several rooms
      // (migration 0146 rewrote legacy single-`rid` rows to `rids: [rid]`).
      const rids = (b.config as { rids?: string[] } | null)?.rids ?? [];
      if (rids.length === 0) continue;
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
      for (const rid of rids) {
        if (routes.has(rid)) {
          // One room routes to exactly one project — first active binding wins.
          logger.warn(
            { connectionId, rid, projectId: b.projectId },
            'rocketchat: room already routed to another project; skipping duplicate',
          );
          continue;
        }
        routes.set(rid, {
          rid,
          projectId: b.projectId,
          projectSlug: proj.slug,
          projectName: proj.name,
          principalUserId: org.createdBy,
        });
      }
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
      onError: (e) => {
        if (!isCurrent()) return;
        logger.warn({ err: e, connectionId }, 'rocketchat: DDP error');
        // Surface DDP-layer failures (subscription lost, link silent, login
        // failure) to Sentry — they live BELOW the message handler, so without
        // this they were invisible (the "replies once then deaf" blind spot).
        Sentry.captureException(e, {
          tags: { area: 'rocketchat', phase: 'ddp' },
          extra: { connectionId },
        });
      },
    });
    ac.client = client;
    try {
      await client.connect();
      ac.reconnectAttempt = 0;
      this.startRefresh(connectionId);
      logger.info({ connectionId }, 'rocketchat: DDP live');
    } catch (err) {
      logger.warn({ err, connectionId }, 'rocketchat: DDP connect failed');
      this.scheduleReconnect(connectionId);
    }
  }

  /** (Re)arm the periodic socket-refresh timer so a silently-dropped
   *  subscription self-heals within DDP_REFRESH_INTERVAL_MS. Each successful
   *  dial re-arms it, so the interval is measured from the last (re)connect. */
  private startRefresh(connectionId: string): void {
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    if (ac.refreshTimer) clearInterval(ac.refreshTimer);
    ac.refreshTimer = setInterval(() => {
      const cur = this.conns.get(connectionId);
      if (!cur || cur.closing) return;
      logger.info({ connectionId }, 'rocketchat: periodic DDP refresh (fresh login + subscription)');
      void this.dial(connectionId);
    }, DDP_REFRESH_INTERVAL_MS);
    ac.refreshTimer.unref?.();
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
    const route = ac.routes.get(m.rid);
    // TEMP DIAGNOSTIC (RC-drop hunt): EVERY message that @-mentions the bot emits
    // a queryable Sentry event carrying the full gate verdict — so a mention that
    // is received but never answered is visible WITHOUT core stdout (the current
    // blind spot). Correlate in Sentry by `msg_id`:
    //   • no "mention received" event for a msg_id  → RC never delivered it (DDP)
    //   • received (gate=ok, route=true) but no "dispatched" → dropped as duplicate
    //   • "dispatched" but no handler outcome         → hung/threw inside handle()
    // Remove once the root cause is pinned.
    const mentionsBot = m.mentions.includes(ac.botUserId);
    if (mentionsBot) {
      Sentry.captureMessage('rocketchat: bot mention received', {
        level: 'info',
        tags: {
          area: 'rocketchat',
          gate: decision.reason,
          has_route: String(!!route),
          msg_id: m.id,
        },
        extra: {
          connectionId,
          rid: m.rid,
          msgId: m.id,
          projectId: route?.projectId ?? null,
          user: m.username,
          textSnippet: m.text.slice(0, 160),
          gateHandle: decision.handle,
          isEdited: m.isEdited,
          isSystem: m.isSystem,
          tmid: m.tmid ?? null,
        },
      });
    }
    if (!decision.handle) return;
    // Route BEFORE dedup: the same bot user is subscribed on every connection's
    // socket, so a connection with NO route for this room must drop the message
    // WITHOUT touching its dedup tracker — otherwise (with the old global
    // tracker) it poisoned the id and the routing connection saw a false dup.
    if (!route) {
      logger.debug({ connectionId, rid: m.rid }, 'rocketchat: no binding for room; ignoring');
      return;
    }
    if (ac.seenMessage(m.id)) {
      if (mentionsBot) {
        Sentry.captureMessage('rocketchat: bot mention dropped as duplicate', {
          level: 'warning',
          tags: { area: 'rocketchat', msg_id: m.id },
          extra: { connectionId, rid: m.rid, msgId: m.id, textSnippet: m.text.slice(0, 160) },
        });
      }
      return; // enrichment re-emit / reconnect replay (per-connection)
    }
    // Delivery marker: proves the mention reached the handler.
    logger.info(
      { connectionId, rid: m.rid, msgId: m.id, user: m.username, projectId: route.projectId },
      'rocketchat: handling mention',
    );
    if (mentionsBot) {
      Sentry.captureMessage('rocketchat: bot mention dispatched to handler', {
        level: 'info',
        tags: { area: 'rocketchat', msg_id: m.id },
        extra: { connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId },
      });
    }
    void this.handle(ac, route, m).catch((err) => {
      logger.error({ err, connectionId, rid: m.rid }, 'rocketchat: message handling failed');
      Sentry.captureException(err, {
        tags: { area: 'rocketchat', phase: 'dispatch' },
        extra: { connectionId, rid: m.rid, projectId: route.projectId },
      });
    });
  }

  private async handle(
    ac: ActiveConnection,
    route: Route,
    m: RocketChatIncomingMessage,
  ): Promise<void> {
    const restAuth = { serverUrl: ac.serverUrl, authToken: ac.authToken, userId: ac.botUserId };
    // Two nested guards so a stall NEVER leaves the mention in silence:
    //  - `abort` (TURN_TIMEOUT_MS) cancels the provider fetch/SSE read.
    //  - `withTimeout` (HANDLE_TIMEOUT_MS) is the whole-handler backstop for a
    //    hang the abort can't reach (a pre-turn DB/session await). On either
    //    fire we send a fallback AND capture to Sentry tagged with `phase`, so
    //    the elusive drop becomes self-diagnosing next time.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
    timer.unref?.();
    let external: ExternalMcpToolsets | undefined;
    let phase = 'start';
    let reply: string;
    try {
      reply = await withTimeout(
        (async (): Promise<string> => {
          // ISS-609 (piece A) — seed the turn with the recent room discussion
          // (+ full thread when threaded); deeper recall stays agentic via the
          // bounded rocketchat_history tool. The project's configured external
          // MCP servers (task hub, …) are bridged in fresh each turn.
          phase = 'context';
          const [conversationContext, agentConfigRow] = await Promise.all([
            buildConversationContext(restAuth, {
              rid: m.rid,
              tmid: m.tmid,
              excludeMessageId: m.id,
              triggerText: m.text,
            }),
            db
              .select({ agentConfig: projects.agentConfig })
              .from(projects)
              .where(eq(projects.id, route.projectId))
              .limit(1),
          ]);
          phase = 'mcp';
          external = await buildExternalMcpToolsets(agentConfigRow[0]?.agentConfig);
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
          const persona = rocketChatPersona(route.projectName, m.username, {
            projectSlug: route.projectSlug,
            webBaseUrl,
            botName: ac.botName,
          });
          phase = 'turn';
          let result = await runExternalChatTurn({
            projectId: route.projectId,
            source: 'rocketchat',
            sessionId: this.sessionByRid.get(m.rid),
            message: m.text,
            tools,
            userKey: m.userId,
            persona,
            conversationContext,
            signal: abort.signal,
          });
          this.sessionByRid.set(m.rid, result.sessionId);
          // Kernel guards: a reply citing issues that don't exist (or claiming
          // a creation that never ran), leaking developer detail to a
          // non-technical stakeholder, or promising work with no follow-up
          // turn never reaches the channel — one corrective retry, then an
          // honest fallback. See reply-guard.ts (live incident 2026-07-07:
          // zero tool calls + fabricated issue link; ISS-672: kernel-hard
          // product-lint + empty-promise guards).
          phase = 'verify';
          let verdict = result.reply.trim()
            ? await this.checkReply(route.projectId, result.reply, result.toolCalls)
            : { ok: true, problems: [] as string[] };
          if (!verdict.ok) {
            logger.warn(
              { rid: m.rid, projectId: route.projectId, problems: verdict.problems },
              'rocketchat: reply failed output guards; corrective retry',
            );
            phase = 'retry';
            result = await runExternalChatTurn({
              projectId: route.projectId,
              source: 'rocketchat',
              sessionId: result.sessionId,
              message: correctiveMessage(verdict.problems),
              tools,
              userKey: m.userId,
              persona,
              conversationContext,
              signal: abort.signal,
            });
            this.sessionByRid.set(m.rid, result.sessionId);
            verdict = result.reply.trim()
              ? await this.checkReply(route.projectId, result.reply, result.toolCalls)
              : { ok: false, problems: ['empty retry reply'] };
            if (!verdict.ok) {
              logger.error(
                { rid: m.rid, projectId: route.projectId, problems: verdict.problems },
                'rocketchat: retry still failing output guards; sending honest fallback',
              );
            }
          }
          return !verdict.ok
            ? unverifiedFallbackReply(ac.botName)
            : result.reply.trim() ||
                (result.terminal === 'error'
                  ? errorFallbackReply(ac.botName)
                  : emptyFallbackReply(ac.botName));
        })(),
        HANDLE_TIMEOUT_MS,
      );
    } catch (err) {
      // The mention was seen — never leave the user in silence. Cancel a still
      // running provider call, drop the room's session pointer (a poisoned
      // session can't wedge every future turn), capture with the phase we hung
      // in, and reply with an honest fallback.
      abort.abort();
      const timedOut = err instanceof HandleTimeoutError;
      logger.error(
        { err, rid: m.rid, projectId: route.projectId, phase, timedOut },
        'rocketchat: chat turn failed',
      );
      Sentry.captureException(err, {
        tags: { area: 'rocketchat', phase, timed_out: String(timedOut) },
        extra: {
          rid: m.rid,
          projectId: route.projectId,
          projectSlug: route.projectSlug,
          user: m.username,
        },
      });
      this.sessionByRid.delete(m.rid);
      reply = errorFallbackReply(ac.botName);
    } finally {
      clearTimeout(timer);
      await external?.dispose();
    }
    // A threaded mention gets its reply in the same thread. Secret-scrub runs
    // unconditionally on the final chosen reply (incl. any fallback) — redact
    // only, never retry, per ISS-672's spec; `ac.authToken` is passed as an
    // extra secret so the bot's own credential is redacted wholesale if it
    // ever echoes.
    const safe = scrubLogText(clipReply(reply), [ac.authToken]);
    await ac.client?.sendMessage(m.rid, safe, m.tmid);
  }

  /** Compose the issue-claim guard with the product-only lint and the
   *  empty-promise guard into one verdict, driving the single
   *  corrective-retry-then-fallback loop in `handle()`. */
  private async checkReply(
    projectId: string,
    reply: string,
    toolCalls: Array<{ name: string; arguments: string }>,
  ): Promise<{ ok: boolean; problems: string[] }> {
    const claim = await this.verifyReplyClaims(projectId, reply, toolCalls);
    const lint = lintStakeholderReply(reply, {
      verifiedSeqs: claim.verifiedSeqs,
      skipIssueIdRule: claim.dbError,
    });
    const promise = detectEmptyPromise(reply);
    return {
      ok: claim.ok && lint.ok && promise.ok,
      problems: [...claim.problems, ...lint.problems, ...promise.problems],
    };
  }

  /** Check a reply's issue references against the DB (project-scoped) and the
   *  turn's actual tool calls. Fails OPEN on DB errors — the guard must never
   *  brick replies on an infra blip. Also surfaces the verified id/seq sets
   *  and a `dbError` flag so `lintStakeholderReply`'s bare-ISS-id rule can
   *  carve out citations already checked here (and skip entirely on a DB
   *  blip, matching this guard's own fail-open behavior). */
  private async verifyReplyClaims(
    projectId: string,
    reply: string,
    toolCalls: Array<{ name: string; arguments: string }>,
  ): Promise<{
    ok: boolean;
    problems: string[];
    verifiedSeqs: Set<number>;
    verifiedUrlIds: Set<string>;
    dbError: boolean;
  }> {
    const claims = extractIssueClaims(reply);
    let ids = new Set<string>();
    let seqs = new Set<number>();
    if (claims.urlIds.length > 0 || claims.issSeqs.length > 0) {
      try {
        const conds = [
          ...(claims.urlIds.length > 0 ? [inArray(issues.id, claims.urlIds)] : []),
          ...(claims.issSeqs.length > 0 ? [inArray(issues.issSeq, claims.issSeqs)] : []),
        ];
        const rows = await db
          .select({ id: issues.id, issSeq: issues.issSeq })
          .from(issues)
          .where(and(eq(issues.projectId, projectId), or(...conds)));
        ids = new Set(rows.map((r) => r.id));
        seqs = new Set(rows.map((r) => r.issSeq));
      } catch (err) {
        logger.warn({ err, projectId }, 'rocketchat: claim verification query failed; skipping');
        return {
          ok: true,
          problems: [],
          verifiedSeqs: new Set(),
          verifiedUrlIds: new Set(),
          dbError: true,
        };
      }
    }
    const verdict = judgeIssueClaims(claims, { ids, seqs }, toolCalls);
    return { ...verdict, verifiedSeqs: seqs, verifiedUrlIds: ids, dbError: false };
  }

  private async teardown(connectionId: string): Promise<void> {
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    ac.closing = true;
    if (ac.reconnectTimer) clearTimeout(ac.reconnectTimer);
    if (ac.refreshTimer) clearInterval(ac.refreshTimer);
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
