/**
 * ISS-604 — Rocket.Chat bot-user connection manager: one long-lived DDP socket
 * per active connection, single-owner via a pg advisory lock so a scaled-out
 * core never double-answers.
 *
 * Since ISS-1004 a message is COLLECTED rather than answered: the socket's job
 * ends when the message is handed to the chat application's `collect` handler
 * (`room-handlers.ts`), and the answer is taken later over everything that
 * arrived together. Nothing here decides whether a message is worth a turn, or
 * what a reply in a Forge thread means — those are the assistant's and the
 * conversations' work.
 */

import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { db } from '../../db/client.js';
import { integrationConnections } from '../../db/schema.js';
import { sessionLockHeld, tryLockSession, unlockSession } from '../../lib/advisory-lock.js';
import { CONNECTION_NAMES } from '../../lib/connection-budget.js';
import { env } from '../../lib/env.js';
import { reportFailure } from '../../lib/error-tracking.js';
import { logger } from '../../lib/logger.js';
import { decryptConnectionSecrets } from '../index.js';
import { RocketChatDdpClient, type RocketChatIncomingMessage } from './ddp-client.js';
import { createSeenTracker, decideSkip, type SeenTracker } from './inbound-gate.js';
import { registerLiveConnection, unregisterLiveConnection } from './live-connections.js';
import { namespaceFromServerUrl } from './namespace.js';
import { fetchOwnIdentity } from './rest-client.js';
import { roomHandlers, supportRoomHandler } from './room-handlers.js';
import { buildRoutes, type Route } from './room-routing.js';
import { resolveRoomShape } from './room-shape.js';
import { subjectForThread } from './thread-registry.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

const MAX_BACKOFF_MS = 30_000;
const RELOAD_CHANNEL = 'forge_rocketchat_reload';
/** How long after its session connection is lost (or fails to open) the manager opens it again. */
const SESSION_RETRY_MS = 5000;
const DDP_REFRESH_INTERVAL_MS = 10 * 60_000;
const capitalize = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export interface ActiveConnection {
  client?: RocketChatDdpClient;
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
  seenMessage: SeenTracker;
  /**
   * The tail of the work already queued for each room.
   */
  routeTails: Map<string, Promise<void>>;
  closing: boolean;
}

class RocketChatConnectionManager {
  private readonly conns = new Map<string, ActiveConnection>();
  private started = false;
  /**
   * The one connection this process's chat holds outside the query pool (ISS-1020): the reload
   * LISTEN and the session advisory lock of every chat connection it owns, so its count is the
   * connection budget's `session` share whatever number of chat connections it owns.
   */
  private session?: pg.Client | undefined;
  private sessionOpening?: Promise<pg.Client> | undefined;
  private sessionRetryTimer?: NodeJS.Timeout | undefined;
  private readonly acquiring = new Set<string>();

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.resume();
  }

  /** Opens the session connection and acquires every active chat connection over it. */
  private async resume(): Promise<void> {
    try {
      await this.ensureSession();
    } catch (err) {
      logger.warn({ err }, 'rocketchat: session connection failed to open; retrying');
      this.scheduleResume();
      return;
    }
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

  /** Whether this process's manager runs; the chat application's drains do nothing until it does. */
  isStarted(): boolean {
    return this.started;
  }

  /** The connections this process owns, for the drains that answer through them. */
  connections(): ReadonlyMap<string, ActiveConnection> {
    return this.conns;
  }

  /**
   * Takes the connection's lock and dials it. A session advisory lock is re-entrant inside the one
   * session that holds every lock here, so this process's own claim is kept out by `conns` and
   * `acquiring`, and only another process's is kept out by the lock.
   */
  private async acquire(connectionId: string): Promise<void> {
    if (this.conns.has(connectionId) || this.acquiring.has(connectionId)) return;
    this.acquiring.add(connectionId);
    try {
      await this.acquireOnce(connectionId);
    } finally {
      this.acquiring.delete(connectionId);
    }
  }

  private async acquireOnce(connectionId: string): Promise<void> {
    const [conn] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    if (!conn?.active) return;

    const session = await this.ensureSession();
    if (!(await tryLockSession(session, 'rocketchatConnection', connectionId))) {
      logger.info({ connectionId }, 'rocketchat: another process owns this connection; skipping');
      return;
    }
    let active: ActiveConnection | null;
    try {
      active = await this.connectionFor(connectionId, conn);
    } catch (err) {
      await unlockSession(session, 'rocketchatConnection', connectionId).catch(() => {});
      throw err;
    }
    if (!active) {
      await unlockSession(session, 'rocketchatConnection', connectionId);
      return;
    }
    this.conns.set(connectionId, active);
    logger.info(
      { connectionId, rooms: [...active.routes.keys()] },
      'rocketchat: connection acquired, dialing',
    );
    await this.dial(connectionId);
  }

  /** The connection's live state from its row, or null when the row cannot be dialled. */
  private async connectionFor(
    connectionId: string,
    conn: typeof integrationConnections.$inferSelect,
  ): Promise<ActiveConnection | null> {
    const secrets = decryptConnectionSecrets<RocketChatSecrets>(conn);
    const config = (conn.config ?? {}) as RocketChatConfig;
    if (!config.serverUrl || !secrets.authToken || !secrets.userId) {
      logger.error({ connectionId }, 'rocketchat: connection missing serverUrl/credentials');
      return null;
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
    return {
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
  }

  private async dial(connectionId: string): Promise<void> {
    const ac = this.conns.get(connectionId);
    if (!ac || ac.closing) return;
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
        reportFailure(e, {
          tags: { area: 'rocketchat', phase: 'ddp' },
          extra: { connectionId },
        });
      },
    });
    ac.client = client;
    try {
      await client.connect();
      ac.reconnectAttempt = 0;
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

  private async route(connectionId: string, m: RocketChatIncomingMessage): Promise<void> {
    const ac = this.conns.get(connectionId);
    if (!ac) return;
    if (decideSkip(m, ac.botUserId)) return;
    // the bindings as they are now: a message is answered under the config saved before it arrived,
    // never under a copy taken when the socket was dialled (REQ-75 r5)
    ac.routes = await buildRoutes(connectionId);
    const route = ac.routes.get(m.rid);
    if (!route) {
      logger.debug({ connectionId, rid: m.rid }, 'rocketchat: no binding for room; ignoring');
      return;
    }
    const restAuth = { serverUrl: ac.serverUrl, authToken: ac.authToken, userId: ac.botUserId };
    const shape = await resolveRoomShape(restAuth, m.rid);
    if (!shape) {
      const ctx = { connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId };
      logger.error(ctx, 'rocketchat: room type unresolved; refusing the message, not assuming one');
      return;
    }
    // a support group and an operations room are each answered by their own session (REQ-75), and
    // a channel agent's rooms by the agent's one session (REQ-77); every active binding naming the
    // room is handed the message, and their prompts say who answers (ISS-933)
    const answered = (r: Route) => Boolean(r.support || r.operations || r.agent);
    if (answered(route)) {
      if (ac.seenMessage(m.id)) return;
      for (const each of [route, ...route.shared.filter(answered)]) {
        await supportRoomHandler()
          .handle({ connectionId, ac, route: each, m, shape })
          .catch((err) => {
            ac.seenMessage.forget(m.id);
            logger.error({ err, connectionId, rid: m.rid }, 'rocketchat: support message failed');
            reportFailure(err, {
              tags: { area: 'rocketchat', phase: 'support' },
              extra: { connectionId, rid: m.rid, projectId: each.projectId },
            });
          });
      }
      return;
    }
    const owned = m.tmid
      ? await subjectForThread({ connectionId, rid: m.rid, tmid: m.tmid })
      : null;
    if (ac.seenMessage(m.id)) return;
    if (owned) {
      roomHandlers().threadReply({ subject: owned, connectionId, ac, m });
      return;
    }
    const logCtx = { connectionId, rid: m.rid, msgId: m.id, projectId: route.projectId };
    logger.info(
      { ...logCtx, user: m.username, shape, threaded: Boolean(m.tmid) },
      'rocketchat: collecting message',
    );
    await roomHandlers()
      .collect({ connectionId, ac, route, m, shape })
      .catch((err) => {
        ac.seenMessage.forget(m.id);
        logger.error({ err, connectionId, rid: m.rid }, 'rocketchat: message collection failed');
        reportFailure(err, {
          tags: { area: 'rocketchat', phase: 'collect' },
          extra: { connectionId, rid: m.rid, projectId: route.projectId },
        });
      });
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
    this.conns.delete(connectionId);
    const session = this.session;
    if (session) {
      await unlockSession(session, 'rocketchatConnection', connectionId).catch((err) =>
        logger.warn({ err, connectionId }, 'rocketchat: connection lock release failed'),
      );
    }
  }

  /**
   * ISS-609 — config hot-reload: connection/binding CRUD (web UI / REST)
   * applies live without a core restart. Tears the socket down (if we own it)
   * and re-acquires; `acquire` no-ops when the connection is now inactive,
   * deleted, or owned by another process. Reached via the pg NOTIFY listener
   * so it runs on every instance, not just the one that served the request.
   */
  async reload(connectionId: string): Promise<void> {
    this.started = true;
    // a binding saved on a connection this process holds changes no socket: the routes are read
    // again, and a message arriving meanwhile is not dropped by a socket torn down and redialled
    if (await this.keepsSocket(connectionId)) return;
    await this.teardown(connectionId);
    await this.acquire(connectionId).catch((err) =>
      logger.error({ err, connectionId }, 'rocketchat: reload failed'),
    );
  }

  /**
   * Whether the connection this process holds is still the one its row names (on, same server, same
   * bot credentials), its routes read again if so. A change to any of those redials.
   */
  private async keepsSocket(connectionId: string): Promise<boolean> {
    const ac = this.conns.get(connectionId);
    if (!ac || ac.closing) return false;
    const [conn] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
      .limit(1);
    if (!conn?.active) return false;
    const secrets = decryptConnectionSecrets<RocketChatSecrets>(conn);
    const config = (conn.config ?? {}) as RocketChatConfig;
    const same =
      config.serverUrl === ac.serverUrl &&
      secrets.authToken === ac.authToken &&
      secrets.userId === ac.botUserId;
    if (!same || this.conns.get(connectionId) !== ac || ac.closing) return false;
    ac.routes = await buildRoutes(connectionId);
    logger.info({ connectionId, rooms: [...ac.routes.keys()] }, 'rocketchat: bindings reread');
    return true;
  }

  /** The session connection, opened once however many callers ask for it at the same time. */
  private ensureSession(): Promise<pg.Client> {
    if (this.session) return Promise.resolve(this.session);
    this.sessionOpening ??= this.openSession().finally(() => {
      this.sessionOpening = undefined;
    });
    return this.sessionOpening;
  }

  private async openSession(): Promise<pg.Client> {
    const client = new pg.Client({
      connectionString: env.DATABASE_URL,
      application_name: CONNECTION_NAMES.session,
    });
    client.on('error', (err) => {
      logger.warn({ err }, 'rocketchat: session connection lost');
      void this.sessionLost(client);
    });
    client.on('notification', (n) => {
      if (n.channel !== RELOAD_CHANNEL || !n.payload) return;
      void this.reload(n.payload);
    });
    try {
      await client.connect();
      await client.query(`listen ${RELOAD_CHANNEL}`);
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    this.session = client;
    logger.info('rocketchat: session connection live (reload listener, connection locks)');
    return client;
  }

  /** Every lock this process held went with the session: its sockets close, and all is taken again. */
  private async sessionLost(lost: pg.Client): Promise<void> {
    if (this.session !== lost) return;
    this.session = undefined;
    void lost.end().catch(() => {});
    for (const connectionId of [...this.conns.keys()]) await this.teardown(connectionId);
    this.scheduleResume();
  }

  private scheduleResume(): void {
    if (!this.started || this.sessionRetryTimer) return;
    this.sessionRetryTimer = setTimeout(() => {
      this.sessionRetryTimer = undefined;
      if (!this.started) return;
      void this.resume().catch((err) =>
        logger.error({ err }, 'rocketchat: resume after session loss failed'),
      );
    }, SESSION_RETRY_MS);
    this.sessionRetryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.sessionRetryTimer) clearTimeout(this.sessionRetryTimer);
    this.sessionRetryTimer = undefined;
    for (const connectionId of [...this.conns.keys()]) {
      await this.teardown(connectionId);
    }
    const session = this.session ?? (await this.sessionOpening?.catch(() => undefined));
    this.session = undefined;
    if (session) await session.end().catch(() => {});
  }
}

export const rocketChatManager = new RocketChatConnectionManager();

/**
 * Whether a core process listens for a connection's messages (REQ-75 r5 BC-26): this one, with its
 * socket live or not, another one (it holds the connection's lock), or none at all.
 */
export type ConnectionListening = 'live' | 'reconnecting' | 'elsewhere' | 'nowhere';

export async function connectionListening(connectionId: string): Promise<ConnectionListening> {
  const here = rocketChatManager.connections().get(connectionId);
  if (here) return here.client?.getState() === 'live' ? 'live' : 'reconnecting';
  return (await sessionLockHeld(db, 'rocketchatConnection', connectionId))
    ? 'elsewhere'
    : 'nowhere';
}
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
