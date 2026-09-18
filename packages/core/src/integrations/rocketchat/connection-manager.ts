/**
 * ISS-604 — Rocket.Chat bot-user connection manager: one long-lived DDP socket
 * per active connection, single-owner via a pg advisory lock so a scaled-out
 * core never double-answers.
 *
 * Since ISS-1004 a message is COLLECTED rather than answered: the socket's job
 * ends when the message is in its conversation's log and in its window, and the
 * answer is taken later by `drainWindows`, over everything that arrived
 * together. Nothing here decides whether a message is worth a turn — that is the
 * proactivity guards' judgement, and it is why this file no longer reads an
 * @-mention.
 */

import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { namespaceFromServerUrl } from '../../assistant/identity/directory.js';
import { env } from '../../config/env.js';
import { collectInboundMessage } from '../../conversations/collect-inbound.js';
import { registerConversationTransport } from '../../conversations/ports.js';
import { db } from '../../db/client.js';
import { integrationConnections } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { Sentry } from '../../observability/sentry.js';
import { hooks } from '../../pipeline/hooks.js';
import { decryptConnectionSecrets } from '../store.js';
import { consumeIssueThreadReply } from './comment-inbound.js';
import { startCommentMirrorLoop } from './comment-mirror.js';
import { type RocketChatFrame, rocketChatConversationPorts } from './conversation-port.js';
import { RocketChatDdpClient, type RocketChatIncomingMessage } from './ddp-client.js';
import { createSeenTracker, decideSkip, type SeenTracker } from './inbound-gate.js';
import { registerLiveConnection, unregisterLiveConnection } from './live-connections.js';
import { FIXED_REPLY_CONSTANT, sendFixedReply } from './outbound.js';
import { startQuestionDrainLoop } from './question-delivery.js';
import { consumeQuestionThreadReply } from './question-inbound.js';
import { fetchOwnIdentity } from './rest-client.js';
import { type RoomShape, resolveRoomShape } from './room-shape.js';
import { buildRoutes, type Route } from './routes.js';
import { subjectForThread } from './thread-registry.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';
import { drainConversationWindows, startWindowDrainLoop } from './window-drain.js';

// cm:guard the first CORS origin IS the web app's origin (operators must allow it for the UI to work at all); exported so the escalation bridge's Bao turn builds the same issue-link base as the sync path
// cm:guard a function, not a const: as a const this read ran at module scope, so importing this file
// — which the integration registry does for every generic path — validated the whole environment and
// threw on a missing variable (ISS-1067). `integrations/github/connect-routes.ts` already spells the
// same value this way. Memoised, so the split still happens once.
let cachedWebBaseUrl: string | undefined;
let webBaseUrlRead = false;
export function webBaseUrl(): string | undefined {
  if (!webBaseUrlRead) {
    cachedWebBaseUrl = env.CORS_ORIGINS.split(',')[0]?.trim().replace(/\/+$/, '') || undefined;
    webBaseUrlRead = true;
  }
  return cachedWebBaseUrl;
}

const LOCK_NAMESPACE = 'forge:rocketchat';
const MAX_BACKOFF_MS = 30_000;
// cm:why gives the DB a beat to come back, and lets another instance win the lock first
const LOCK_REACQUIRE_DELAY_MS = 5000;
// cm:guard fan CRUD to EVERY core instance — the advisory-lock owner may not be the process that served the HTTP request
const RELOAD_CHANNEL = 'forge_rocketchat_reload';
const LISTEN_RETRY_MS = 5000;
// cm:guard a subscription can die WITHOUT a `nosub` while server pings keep the link alive, so the watchdog never fires and the bot goes silently deaf; this periodic fresh login+sub bounds that window, and the `nosub` handler covers the signalled case
const DDP_REFRESH_INTERVAL_MS = 10 * 60_000;
const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export interface ActiveConnection {
  client?: RocketChatDdpClient;
  lockClient: pg.Client;
  botUserId: string;
  /** Capitalized RC handle ("Babo") — the bot's self-reference in replies. */
  botName: string;
  /** The bot's username and the display name the server may show instead, for the activity stream (ISS-1088). */
  ownUsername: string | null;
  displayName: string | null;
  serverUrl: string;
  authToken: string;
  routes: Map<string, Route>;
  reconnectAttempt: number;
  reconnectTimer?: NodeJS.Timeout | undefined;
  refreshTimer?: NodeJS.Timeout | undefined;
  // cm:guard MUST stay per-connection: the same bot user is subscribed on every org connection via `__my_messages__`, so a manager-global tracker let a routeless connection mark an id seen first and the routing connection dropped it as a false duplicate (root cause, 2026-07-15)
  seenMessage: SeenTracker;
  /**
   * The tail of the work already queued for each room.
   */
  // cm:guard routing is serialized PER ROOM and never fanned out: the shape and thread lookups are round trips, so two messages typed a moment apart can finish them in either order, and the one that finishes first takes the lower seq. The window then shows the model "deploy to staging" before "do not deploy", which is the pair reversed (ISS-1004, review pass 2 F4).
  routeTails: Map<string, Promise<void>>;
  closing: boolean;
}

class RocketChatConnectionManager {
  private readonly conns = new Map<string, ActiveConnection>();
  private started = false;
  private listenClient?: pg.Client | undefined;
  private listenRetryTimer?: NodeJS.Timeout | undefined;
  private stopQuestionDrain?: (() => void) | undefined;
  private stopWindowDrain?: (() => void) | undefined;
  private stopCommentMirror?: (() => void) | undefined;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // cm:why listen even with zero connections — the first-ever connect arrives as a NOTIFY from whichever instance served the HTTP request
    this.startReloadListener();
    registerConversationTransport(rocketChatConversationPorts);
    this.stopQuestionDrain = startQuestionDrainLoop(() => this.started);
    this.stopWindowDrain = startWindowDrainLoop(
      () => this.started,
      () => drainConversationWindows(this.conns, webBaseUrl()),
    );
    this.stopCommentMirror = startCommentMirrorLoop(() => this.started, hooks);
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
    const [routes, identity] = await Promise.all([
      buildRoutes(connectionId),
      fetchOwnIdentity(restAuth),
    ]);
    const active: ActiveConnection = {
      lockClient,
      botUserId: secrets.userId,
      botName: capitalize(identity.username ?? 'bot'),
      ownUsername: identity.username,
      displayName: identity.displayName,
      serverUrl: config.serverUrl,
      authToken: secrets.authToken,
      routes,
      reconnectAttempt: 0,
      seenMessage: createSeenTracker(),
      routeTails: new Map(),
      closing: false,
    };
    this.conns.set(connectionId, active);
    logger.info(
      { connectionId, rooms: [...routes.keys()] },
      'rocketchat: connection acquired, dialing',
    );
    await this.dial(connectionId);
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
      // cm:guard registered on EVERY successful dial and under the connection's id: a redial replaces the socket, and the port must find the live one, not the one that closed; a fresh registration also forgets a refusal the previous socket earned (ISS-1088 criteria 25, 27).
      registerLiveConnection(connectionId, {
        namespace: namespaceFromServerUrl(ac.serverUrl) ?? ac.serverUrl,
        client,
        username: ac.ownUsername,
        displayName: ac.displayName,
      });
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
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    const prior = ac.routeTails.get(m.rid) ?? Promise.resolve();
    const next = prior
      .then(() => this.route(connectionId, m))
      .catch((err) => logger.error({ err, connectionId, rid: m.rid }, 'rocketchat: routing failed'))
      .finally(() => {
        if (ac.routeTails.get(m.rid) === next) ac.routeTails.delete(m.rid);
      });
    ac.routeTails.set(m.rid, next);
  }

  // cm:guard the order is still the one ISS-987 built and each step is why the next is safe: the shape-free skips first because they need no round trip; the ROUTE before anything async, so a routeless connection neither resolves a shape nor touches its tracker; then the shape, which the venue needs; then the thread lookup, which decides WHICH handler; and the tracker last. What ISS-1004 removed is the addressing step between the shape and the tracker — every message in a bound room is now collected, so the tracker's entries are no longer rationed against unmentioned chatter and its only job is the duplicate re-emit it was added for.
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
    // cm:guard refuse by NAME rather than assume a shape: `group` would make a direct room need the wrong authority in a one-to-one room and `direct` would run a channel's chatter as whoever spoke. An unresolvable room is a fault to see in the log, not a default to serve (ISS-987).
    if (!shape) {
      const ctx = { connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId };
      logger.error(ctx, 'rocketchat: room type unresolved; refusing the message, not assuming one');
      return;
    }
    // cm:guard the thread lookup runs AFTER the route for the same reason the shape does: a connection with no binding for this room must touch nothing. It decides WHICH handler takes the message, and a registered thread never reaches the collector (ISS-978 criterion 22).
    const owned = m.tmid
      ? await subjectForThread({ connectionId, rid: m.rid, tmid: m.tmid })
      : null;
    if (ac.seenMessage(m.id)) return;
    // cm:guard a registered thread is CONSUMED here and never falls through to the collector — refusals included. A refusal that fell through would reach the person who was asked to pick option 2 as a chat reply about something else, and would additionally run a provider turn nobody asked for (ISS-978 criteria 20, 21).
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
      'rocketchat: collecting message',
    );
    // cm:guard the collect is AWAITED inside the room's queue, which is what makes the seq order the arrival order; and a collect that failed takes its mark back off the tracker, so RC's enrichment re-emit of the same id is a second chance rather than a false duplicate (ISS-1004, review pass 2 F3, F4).
    await this.collect(ac, route, m, connectionId, shape).catch((err) => {
      ac.seenMessage.forget(m.id);
      logger.error({ err, connectionId, rid: m.rid }, 'rocketchat: message collection failed');
      Sentry.captureException(err, {
        tags: { area: 'rocketchat', phase: 'collect' },
        extra: { connectionId, rid: m.rid, projectId: route.projectId },
      });
    });
  }

  /**
   * Take one message in. Nothing is answered here.
   */
  // cm:guard the turn is the WINDOW's and this only collects: answering per message is what made two messages typed seconds apart two decisions and two bills, and a turn taken on the socket leaves nothing behind when the process stops mid-way (ISS-1004 rule 1).
  private async collect(
    ac: ActiveConnection,
    route: Route,
    m: RocketChatIncomingMessage,
    connectionId: string,
    shape: RoomShape,
  ): Promise<void> {
    const logCtx = { connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId };
    const frame: RocketChatFrame = {
      m,
      auth: { serverUrl: ac.serverUrl, authToken: ac.authToken, userId: ac.botUserId },
      projectId: route.projectId,
      shape,
    };
    const outcome = await collectInboundMessage({
      ports: rocketChatConversationPorts,
      frame,
      message: m.text,
      speakerKey: m.userId,
      speakerLabel: m.username ?? null,
      externalMessageId: m.id,
      replyToExternalId: m.replyToId ?? null,
      images: m.images,
      manySpeakersPrincipalUserId: route.principalUserId,
    });

    if (outcome.kind === 'venue-unresolved') {
      logger.error(logCtx, 'rocketchat: venue unresolved; refusing the message, not inventing one');
      await this.sayWhyUnplaceable(ac, m, shape, frame);
      return;
    }
    logger.debug(
      { ...logCtx, windowId: outcome.windowId, seq: outcome.seq },
      'rocketchat: collected',
    );
  }

  /**
   * The one reply this adapter still sends itself, and the reason it must.
   */
  // cm:guard a venue that could not be placed has no venue to deliver THROUGH, so the neutral door cannot be reached and this socket is the only way to the person. It is confined to a one-to-one room on purpose: a group room runs under the binding's principal and is owed no answer about an identity it never consults, which is the misdescription ISS-1002's review refused.
  // cm:guard the text is the speaker port's own and is not rewritten here — for this fault it names the server address that could not be read, which is the thing an operator has to change.
  private async sayWhyUnplaceable(
    ac: ActiveConnection,
    m: RocketChatIncomingMessage,
    shape: RoomShape,
    frame: RocketChatFrame,
  ): Promise<void> {
    if (shape !== 'direct' || !ac.client) return;
    const speaker = await rocketChatConversationPorts.resolveSpeaker(frame);
    if (speaker.linked) return;
    await sendFixedReply(
      { kind: 'ddp', client: ac.client, rid: m.rid, tmid: m.tmid, authToken: ac.authToken },
      speaker.refusal.message,
      FIXED_REPLY_CONSTANT,
    );
  }

  private async teardown(connectionId: string): Promise<void> {
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    ac.closing = true;
    if (ac.reconnectTimer) clearTimeout(ac.reconnectTimer);
    if (ac.refreshTimer) clearInterval(ac.refreshTimer);
    unregisterLiveConnection(connectionId);
    try {
      ac.client?.close();
    } catch {}
    // cm:why a teardown swallows both failures rather than reporting them: the socket and the lock are being given up, so a close that fails has already lost the thing the failure is about.
    try {
      await ac.lockClient.query('select pg_advisory_unlock(hashtext($1), hashtext($2))', [
        LOCK_NAMESPACE,
        connectionId,
      ]);
      await ac.lockClient.end();
    } catch {}
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
    // cm:why an idle manager — no connections at boot — may start owning one at a reload
    this.started = true;
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
    // cm:guard a stale event from a client this manager already replaced restarts nothing
    if (this.listenClient !== failed) return;
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
    this.stopWindowDrain?.();
    this.stopWindowDrain = undefined;
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
