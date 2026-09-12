/**
 * ISS-604 — Rocket.Chat bot-user connection manager: one long-lived DDP socket
 * per active connection, single-owner via a pg advisory lock so a scaled-out
 * core never double-answers, routing @-mentions to a reply in the same room.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { type ExternalChatTurnResult, runExternalChatTurn } from '../../assistant/external-chat.js';
import { ESCALATE_TOOL_NAME } from '../../assistant/tools/escalate.js';
import {
  buildExternalMcpToolsets,
  type ExternalMcpToolsets,
} from '../../assistant/tools/external-mcp.js';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { integrationConnections, organizations, projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { Sentry } from '../../observability/sentry.js';
import { hooks } from '../../pipeline/hooks.js';
import { decryptConnectionSecrets, listBindingsForConnection } from '../store.js';
import {
  AGENT_CHAT_DEDUP_REPLY,
  AGENT_CHAT_NO_DEVICE_REPLY,
  startAgentChat,
} from './agent-chat.js';
import { readRocketChatAnswerMode } from './answer-mode.js';
import { consumeIssueThreadReply } from './comment-inbound.js';
import { startCommentMirrorLoop } from './comment-mirror.js';
import { buildConversationContext } from './context.js';
import { RocketChatDdpClient, type RocketChatIncomingMessage } from './ddp-client.js';
import {
  ESCALATION_ACK,
  ESCALATION_DEDUP_REPLY,
  ESCALATION_NO_DEVICE_REPLY,
  startEscalation,
} from './escalation.js';
import { type FastTurnInputs, prepareFastTurn } from './images.js';
import { createSeenTracker, decideHandling, decideSkip } from './inbound-gate.js';
import { FIXED_REPLY_CONSTANT, type ReplySendProof, sendFixedReply } from './outbound.js';
import { rocketChatPersona } from './persona.js';
import { startQuestionDrainLoop } from './question-delivery.js';
import { consumeQuestionThreadReply } from './question-inbound.js';
import { screenStakeholderReply } from './reply-screen.js';
import { fetchOwnUsername } from './rest-client.js';
import { type RoomShape, resolveRoomShape } from './room-shape.js';
import { subjectForThread } from './thread-registry.js';
import { conversationKey, resolveTurnPrincipal } from './turn-principal.js';
import type { RocketChatBindingConfig, RocketChatConfig, RocketChatSecrets } from './types.js';

// cm:guard the first CORS origin IS the web app's origin (operators must allow it for the UI to work at all); exported so the escalation bridge's Bao turn builds the same issue-link base as the sync path
export const webBaseUrl = env.CORS_ORIGINS.split(',')[0]?.trim().replace(/\/+$/, '') || undefined;

const LOCK_NAMESPACE = 'forge:rocketchat';
const MAX_BACKOFF_MS = 30_000;
// cm:why gives the DB a beat to come back, and lets another instance win the lock first
const LOCK_REACQUIRE_DELAY_MS = 5000;
// cm:guard fan CRUD to EVERY core instance — the advisory-lock owner may not be the process that served the HTTP request
const RELOAD_CHANNEL = 'forge_rocketchat_reload';
const LISTEN_RETRY_MS = 5000;
// cm:guard a subscription can die WITHOUT a `nosub` while server pings keep the link alive, so the watchdog never fires and the bot goes silently deaf; this periodic fresh login+sub bounds that window, and the `nosub` handler covers the signalled case
const DDP_REFRESH_INTERVAL_MS = 10 * 60_000;
// cm:why cancels the provider fetch/SSE read so a stalled upstream terminates as an error instead of hanging
const TURN_TIMEOUT_MS = 90_000;
// cm:guard must stay ABOVE TURN_TIMEOUT_MS so a normal provider-abort resolves first: the abort signal only reaches the provider, so an unbounded await BEFORE the turn (hung DB query, stuck session load) would wedge the handler in silence without this backstop
const HANDLE_TIMEOUT_MS = 120_000;

class HandleTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`rocketchat handle timed out after ${ms}ms`);
    this.name = 'HandleTimeoutError';
  }
}

// cm:guard does NOT cancel `p` — the caller aborts the provider separately; this only frees the handler to send a fallback and report
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

// cm:guard fallbacks speak AS the bot by name — never as an anonymous "the system" or "the model" voice
const errorFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} đang quá tải hoặc gặp sự cố — bạn thử lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

// cm:guard ISS-818 — name the REASON: a bare "couldn't verify" reads to a stakeholder as "didn't understand you" so they rephrase, which cannot help because the question WAS understood and the answer failed the check
const unverifiedFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} chưa đối chiếu được số liệu dự án nên không dám gửi câu trả lời chưa chắc chắn — không phải do câu hỏi của bạn, bạn hỏi lại sau ít phút nhé.`; // i18n-allow: user-facing channel reply

const emptyFallbackReply = (name: string): string =>
  `Xin lỗi, ${name} chưa đưa ra được câu trả lời cho yêu cầu này — bạn diễn đạt lại giúp ${name} nhé.`; // i18n-allow: user-facing channel reply

const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const correctiveMessage = (problems: string[]): string =>
  `[SYSTEM CHECK — not from the user] Your previous reply cannot be sent as-is: ${problems.join('; ')}. Rewrite it now, keep only verified facts, actually CALL the tools if work is needed, cite issue ids/links only exactly as tools returned them, and reply in the user's language.`;

// cm:guard `send: false` is the explicit "this turn posts nothing" case — the completion bridge delivers that reply asynchronously, so posting here too double-replies
type TurnOutcome = { send: false } | { send: true; text: string; proof: ReplySendProof };

const fixed = (text: string): TurnOutcome => ({ send: true, text, proof: FIXED_REPLY_CONSTANT });

interface Route {
  rid: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  principalUserId: string;
}

interface ActiveConnection {
  client?: RocketChatDdpClient;
  lockClient: pg.Client;
  botUserId: string;
  /** Capitalized RC handle ("Babo") — the bot's self-reference in replies. */
  botName: string;
  serverUrl: string;
  authToken: string;
  routes: Map<string, Route>;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout | undefined;
  refreshTimer?: NodeJS.Timeout | undefined;
  // cm:guard MUST stay per-connection: the same bot user is subscribed on every org connection via `__my_messages__`, so a manager-global tracker let a routeless connection mark an id seen first and the routing connection dropped it as a false duplicate (root cause, 2026-07-15)
  seenMessage: (id: string) => boolean;
  closing: boolean;
}

class RocketChatConnectionManager {
  private readonly conns = new Map<string, ActiveConnection>();
  // cm:guard keyed by the CONVERSATION and never the room: a thread exists so a side conversation need not be followed by the room, and one key per rid put two live threads in one `chat_sessions` row reading each other's turns back as their own history (ISS-987). The room's own messages are their own conversation under the same rule.
  private readonly sessionByConversation = new Map<string, string>();
  private started = false;
  private listenClient?: pg.Client | undefined;
  private listenRetryTimer?: NodeJS.Timeout | undefined;
  private stopQuestionDrain?: (() => void) | undefined;
  private stopCommentMirror?: (() => void) | undefined;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // cm:why listen even with zero connections — the first-ever connect arrives as a NOTIFY from whichever instance served the HTTP request
    this.startReloadListener();
    this.stopQuestionDrain = startQuestionDrainLoop(() => this.started);
    this.stopCommentMirror = startCommentMirrorLoop(() => this.started);
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
    if (!conn?.active) return;

    // cm:guard single-owner: a DEDICATED pg connection, never the pooled `db` — `pg_try_advisory_lock` is SESSION-scoped, so the lock binds to THIS backend session and is released only by an explicit unlock or by that session ending. Taken on a pooled checkout it goes back into the pool still attached, where this manager can no longer release it and no other instance can take it: the room then has a lock with no owner instead of one owner
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

    // cm:guard a dead lock connection means the advisory lock is GONE (session-scoped), and without this listener pg.Client's 'error' event crashes the process
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
    // cm:why two batched lookups, not a projects+organizations pair per binding: this was 1+2N round-trips and `reload` fires on ANY connection/binding CRUD, so a 10-binding connection paid 21 of them every reload
    const active = (await listBindingsForConnection(connectionId))
      .map(({ binding: b }) => ({
        b,
        rids: (b.config as RocketChatBindingConfig | null)?.rids ?? [],
      }))
      .filter(({ b, rids }) => b.active && rids.length > 0);
    if (active.length === 0) return routes;

    const projectRows = await db
      .select({ id: projects.id, slug: projects.slug, name: projects.name, orgId: projects.orgId })
      .from(projects)
      .where(inArray(projects.id, [...new Set(active.map(({ b }) => b.projectId))]));
    const projectById = new Map(projectRows.map((p) => [p.id, p]));
    const orgIds = [...new Set(projectRows.map((p) => p.orgId))];
    const ownerByOrg = new Map(
      orgIds.length === 0
        ? []
        : (
            await db
              .select({ id: organizations.id, createdBy: organizations.createdBy })
              .from(organizations)
              .where(inArray(organizations.id, orgIds))
          ).map((o) => [o.id, o.createdBy] as const),
    );

    for (const { b, rids } of active) {
      const proj = projectById.get(b.projectId);
      if (!proj) continue;
      const principalUserId = ownerByOrg.get(proj.orgId);
      if (!principalUserId) continue;
      for (const rid of rids) {
        // cm:guard one room routes to exactly one project and the FIRST binding wins, which is only deterministic because listBindingsForConnection orders by desc(createdAt) — reorder that query and a re-bound room silently changes project
        if (routes.has(rid)) {
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
          principalUserId,
        });
      }
    }
    return routes;
  }

  private async dial(connectionId: string): Promise<void> {
    const ac = this.conns.get(connectionId);
    if (!ac || ac.closing) return;
    // cm:guard gate every callback on still being current — a slow-dying socket that triggers a second dial leaves two live sockets, i.e. duplicate deliveries
    try {
      ac.client?.close();
    } catch {}
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
        // cm:why DDP-layer failures live BELOW the message handler, so without this they were invisible — the replies-once-then-deaf blind spot
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

  // cm:why each successful dial re-arms this, so the interval is measured from the last (re)connect
  private startRefresh(connectionId: string): void {
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    if (ac.refreshTimer) clearInterval(ac.refreshTimer);
    ac.refreshTimer = setInterval(() => {
      const cur = this.conns.get(connectionId);
      if (!cur || cur.closing) return;
      logger.info(
        { connectionId },
        'rocketchat: periodic DDP refresh (fresh login + subscription)',
      );
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
    void this.route(connectionId, m).catch((err) =>
      logger.error({ err, connectionId, rid: m.rid }, 'rocketchat: routing failed'),
    );
  }

  // cm:guard the four steps are ordered and each one is why the next is safe: the shape-free skips first because they need no round trip; the ROUTE before anything async, so a routeless connection neither resolves a shape nor touches its tracker; the SHAPE before addressing, because addressing is what the shape decides; and the tracker LAST, so an unmentioned group message never occupies an entry it would evict a real mention with (ISS-987 rebuilt this order — the pre-ISS-987 gate tested the mention synchronously and could sit first).
  private async route(connectionId: string, m: RocketChatIncomingMessage): Promise<void> {
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    if (decideSkip(m, ac.botUserId)) return;
    // cm:guard route BEFORE dedup: the same bot user is subscribed on EVERY connection's socket via `__my_messages__`, so a connection with no route for this room must drop the message without touching its dedup tracker — a shared/global tracker let a routeless connection mark the id seen first, so the connection that owned the route dropped it as a false duplicate (root cause of the intermittent "bot ignores the message", pinned 2026-07-15)
    const route = ac.routes.get(m.rid);
    if (!route) {
      logger.debug({ connectionId, rid: m.rid }, 'rocketchat: no binding for room; ignoring');
      return;
    }
    const restAuth = { serverUrl: ac.serverUrl, authToken: ac.authToken, userId: ac.botUserId };
    const shape = await resolveRoomShape(restAuth, m.rid);
    // cm:guard refuse by NAME rather than assume a shape: `group` would make a direct room need a mention it never gets, and `direct` would answer unmentioned channel chatter and run it as whoever spoke. An unresolvable room is a fault to see in the log, not a default to serve (ISS-987).
    if (!shape) {
      const ctx = { connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId };
      logger.error(ctx, 'rocketchat: room type unresolved; refusing the message, not assuming one');
      return;
    }
    // cm:guard the thread lookup runs BEFORE `decideHandling` because it is an input to it, and AFTER the route for the same reason the shape is: a connection with no binding for this room must touch nothing (ISS-978 criterion 22).
    const owned = m.tmid
      ? await subjectForThread({ connectionId, rid: m.rid, tmid: m.tmid })
      : null;
    if (!decideHandling(m, ac.botUserId, shape, Boolean(owned)).handle) return;
    if (ac.seenMessage(m.id)) return;
    // cm:guard a registered thread is CONSUMED here and never falls through to `this.handle` — refusals included. A refusal that fell through would reach the person who was asked to pick option 2 as a chat reply about something else, and would additionally run a provider turn nobody asked for (ISS-978 criteria 20, 21).
    // cm:guard the SUBJECT decides which handler, and the two are not interchangeable: a question thread answers an option under `answerAs`'s authority gate, an issue thread writes a comment — routing a prose reply to the first would grant a permission nobody chose, and a chosen option to the second would resume the run twice (ISS-981 criteria 18, 29).
    if (owned) {
      if (owned.kind === 'question') {
        consumeQuestionThreadReply({ questionId: owned.questionId, connectionId, ac, m });
      } else {
        consumeIssueThreadReply({
          issueId: owned.issueId,
          retired: owned.retired,
          connectionId,
          ac,
          m,
          hooks,
        });
      }
      return;
    }
    const logCtx = { connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId };
    logger.info(
      { ...logCtx, user: m.username, shape, threaded: Boolean(m.tmid) },
      'rocketchat: handling message',
    );
    void this.handle(ac, route, m, connectionId, shape).catch((err) => {
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
    connectionId: string,
    shape: RoomShape,
  ): Promise<void> {
    const restAuth = { serverUrl: ac.serverUrl, authToken: ac.authToken, userId: ac.botUserId };
    const conversation = conversationKey(m);
    const principal = await resolveTurnPrincipal({
      serverUrl: ac.serverUrl,
      routePrincipalUserId: route.principalUserId,
      projectId: route.projectId,
      m,
      shape,
      onRefusal: (d) => logger.warn(d, 'rocketchat: direct speaker unresolved; refusing the turn'),
    });
    // cm:guard the refusal is the deliverable and the turn does NOT run: a DM's authority is its one human, so with nobody resolved there is no identity to compute an answer under — falling back to the organization's creator would answer a stranger with the creator's read access (ISS-987, consuming ISS-977).
    if (!principal.ok) {
      const client = ac.client;
      if (client) {
        await sendFixedReply(
          { kind: 'ddp', client, rid: m.rid, tmid: m.tmid, authToken: ac.authToken },
          principal.refusal,
          FIXED_REPLY_CONSTANT,
        );
      }
      return;
    }
    // cm:guard two nested guards so a stall NEVER leaves the mention in silence: `abort` cancels the provider, `withTimeout` backstops a hang the abort cannot reach; either fire sends a fallback AND captures to Sentry tagged with `phase`
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TURN_TIMEOUT_MS);
    timer.unref?.();
    let external: ExternalMcpToolsets | undefined;
    let phase = 'start';
    let outcome: TurnOutcome;
    try {
      outcome = await withTimeout(
        (async (): Promise<TurnOutcome> => {
          // cm:why the turn is seeded with the recent room discussion, and the full thread when threaded, because deeper recall stays agentic through the bounded history tool rather than being paid for on every turn (ISS-609).
          phase = 'context';
          const [conversationContext, projectRow] = await Promise.all([
            buildConversationContext(restAuth, {
              rid: m.rid,
              tmid: m.tmid,
              excludeMessageId: m.id,
              triggerText: m.text,
            }),
            db
              .select({ agentConfig: projects.agentConfig, repoPath: projects.repoPath })
              .from(projects)
              .where(eq(projects.id, route.projectId))
              .limit(1),
          ]);
          const persona = rocketChatPersona(route.projectName, m.username, {
            projectSlug: route.projectSlug,
            webBaseUrl,
            botName: ac.botName,
          });

          // cm:guard `agent` mode routes the WHOLE turn to a runner-hosted session and sends nothing but an ack synchronously — the reply lands later through the completion bridge, so code added below this branch runs only on the fast path and a reply written there is never seen in agent mode (ISS-727).
          if (readRocketChatAnswerMode(projectRow[0]?.agentConfig) === 'agent') {
            phase = 'agent-chat';
            const started = await startAgentChat({
              projectId: route.projectId,
              project: {
                id: route.projectId,
                slug: route.projectSlug,
                repoPath: projectRow[0]?.repoPath ?? null,
              },
              connectionId,
              rid: m.rid,
              tmid: m.tmid,
              botName: ac.botName,
              message: m.text,
              askedByUsername: m.username,
              persona,
              conversationContext,
            });
            // cm:guard send NOTHING when the dispatch started: only a genuinely slow turn gets an interim ack, scheduled by startAgentChat itself (scheduleDelayedAck). Acking here would put a promise in front of an answer that usually arrives first
            if (started.started) return { send: false };
            if (started.reason === 'deduped') return fixed(AGENT_CHAT_DEDUP_REPLY(ac.botName));
            if (started.reason === 'no-device')
              return fixed(AGENT_CHAT_NO_DEVICE_REPLY(ac.botName));
            // cm:guard 'dispatch-failed' sends nothing either — the session was created then marked failed, so the completion bridge already delivers the one honest fallback over REST; replying here too double-posts
            return { send: false };
          }

          phase = 'mcp';
          external = await buildExternalMcpToolsets(projectRow[0]?.agentConfig);
          phase = 'images';
          const fast = await prepareFastTurn({
            route,
            principalUserId: principal.userId,
            restAuth,
            rid: m.rid,
            images: m.images,
            externalToolsets: external.toolsets,
          });
          phase = 'turn';
          const result = await runExternalChatTurn({
            projectId: route.projectId,
            source: 'rocketchat',
            sessionId: this.sessionByConversation.get(conversation),
            message: m.text,
            tools: fast.tools,
            userKey: m.userId,
            persona,
            conversationContext,
            images: fast.images,
            resolveImage: fast.resolveImage,
            signal: abort.signal,
          });
          this.sessionByConversation.set(conversation, result.sessionId);

          // ISS-675 — escalation short-circuits the normal verify/reply path:
          // the model chose to hand this question to a deeper research agent
          // instead of answering now. Post a fixed, guard-exempt ACK (a
          // legitimate promise — a real async follow-up lands via the
          // completion bridge) and skip the rest of this turn entirely.
          const escalateCall = result.toolCalls.find((t) => t.name === ESCALATE_TOOL_NAME);
          if (escalateCall) {
            phase = 'escalate';
            let question = m.text;
            try {
              const parsed = JSON.parse(escalateCall.arguments) as { question?: unknown };
              if (typeof parsed.question === 'string' && parsed.question.trim()) {
                question = parsed.question.trim();
              }
            } catch {
              // cm:why a malformed tool-call argument is not worth failing the turn over — the escalation still carries the user's own message text, which is what a research agent needs
            }
            const started = await startEscalation({
              projectId: route.projectId,
              project: {
                id: route.projectId,
                slug: route.projectSlug,
                repoPath: projectRow[0]?.repoPath ?? null,
              },
              connectionId,
              rid: m.rid,
              tmid: m.tmid,
              botName: ac.botName,
              question,
              askedByUsername: m.username,
              shape,
              principalUserId: principal.userId,
            });
            if (started.started) return fixed(ESCALATION_ACK(ac.botName));
            if (started.reason === 'deduped') return fixed(ESCALATION_DEDUP_REPLY(ac.botName));
            if (started.reason === 'no-device')
              return fixed(ESCALATION_NO_DEVICE_REPLY(ac.botName));
            // cm:guard same as agent mode: on 'dispatch-failed' the bridge delivers the single fallback, so this turn must post nothing
            return { send: false };
          }

          // Kernel guards: a reply citing issues that don't exist (or claiming
          // a creation that never ran), leaking developer detail to a
          // non-technical stakeholder, or promising work with no follow-up
          // turn never reaches the channel — one corrective retry, then an
          // honest fallback. See reply-guard.ts (live incident 2026-07-07:
          // zero tool calls + fabricated issue link; ISS-672: kernel-hard
          // product-lint + empty-promise guards).
          return await this.screenWithRetry({
            route,
            m,
            botName: ac.botName,
            first: result,
            fast,
            persona,
            conversationContext,
            signal: abort.signal,
            setPhase: (p) => {
              phase = p;
            },
          });
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
      this.sessionByConversation.delete(conversation);
      outcome = fixed(errorFallbackReply(ac.botName));
    } finally {
      clearTimeout(timer);
      await external?.dispose();
    }
    // cm:why delivery only, never a second guard pass: every branch above already screened its text or replaced it with a code-authored constant, and the proof rides along on the outcome
    if (outcome.send && ac.client) {
      await sendFixedReply(
        { kind: 'ddp', client: ac.client, rid: m.rid, tmid: m.tmid, authToken: ac.authToken },
        outcome.text,
        outcome.proof,
      );
    }
  }

  // cm:guard exactly ONE corrective retry, then an honest fallback — never a second: each retry is a full model turn inside HANDLE_TIMEOUT_MS, and a model that failed the guard twice does not converge on a third
  private async screenWithRetry(args: {
    route: Route;
    m: RocketChatIncomingMessage;
    botName: string;
    first: ExternalChatTurnResult;
    fast: FastTurnInputs;
    persona: string;
    conversationContext: string | null;
    signal: AbortSignal;
    setPhase: (phase: string) => void;
  }): Promise<TurnOutcome> {
    const { route, m, botName, fast, persona, conversationContext, signal, setPhase } = args;
    const screen = (r: ExternalChatTurnResult) =>
      screenStakeholderReply(route.projectId, r.reply, r.toolCalls, r.progress);
    let result = args.first;

    setPhase('verify');
    let verdict = result.reply.trim()
      ? await screen(result)
      : { ok: true, problems: [] as string[] };
    if (!verdict.ok) {
      logger.warn(
        { rid: m.rid, projectId: route.projectId, problems: verdict.problems },
        'rocketchat: reply failed output guards; corrective retry',
      );
      setPhase('retry');
      result = await runExternalChatTurn({
        projectId: route.projectId,
        source: 'rocketchat',
        sessionId: result.sessionId,
        message: correctiveMessage(verdict.problems),
        tools: fast.tools,
        userKey: m.userId,
        persona,
        conversationContext,
        resolveImage: fast.resolveImage,
        signal,
      });
      this.sessionByConversation.set(conversationKey(m), result.sessionId);
      verdict = result.reply.trim()
        ? await screen(result)
        : { ok: false, problems: ['empty retry reply'] };
      if (!verdict.ok) {
        logger.error(
          { rid: m.rid, projectId: route.projectId, problems: verdict.problems },
          'rocketchat: retry still failing output guards; sending honest fallback',
        );
      }
    }
    if (!verdict.ok) return fixed(unverifiedFallbackReply(botName));
    const trimmedReply = result.reply.trim();
    if (!trimmedReply) {
      return fixed(
        result.terminal === 'error' ? errorFallbackReply(botName) : emptyFallbackReply(botName),
      );
    }
    // cm:guard the verdict travels WITH the text as its proof — the only shape sendFixedReply accepts for model-generated output, so no later branch can send unscreened text under a stale proof
    return { send: true, text: trimmedReply, proof: { ok: true, problems: verdict.problems } };
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
    this.stopQuestionDrain?.();
    this.stopQuestionDrain = undefined;
    this.stopCommentMirror?.();
    this.stopCommentMirror = undefined;
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
