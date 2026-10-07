// "Reporter told": whether the reporter heard that an item's work shipped, read off the record of the
// telling, never off a flag that could drift from it. A release's notice that reached their bell tells
// them (`notifications/notify-feedback.ts`); so does a message to reporters sent once the work shipped,
// or a relay a person recorded for a reporter no bell reaches (a reporters message with no recipient).
// While nothing told them, the item owes a holder of feedback.approve that relay (`standing.ts`).

import type { FeedbackPhase, FeedbackShipNotice } from '@forge/contracts/feedback';
import { feedbackShippedPrefix } from '@forge/contracts/notifications';
import { and, desc, eq, inArray, like, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, notificationDeliveryMembers, notifications, pipelineRuns } from '../db/schema.js';
import { feedbackMessages, feedbackRouteIssues } from '../db/schema-feedback.js';
import { pipelineOutbox } from '../db/schema-outbox.js';
import { userNames } from '../lib/people.js';
import { holderNames } from '../permissions/index.js';

const SHIPPED_PHASES: readonly FeedbackPhase[] = ['resolved', 'verified'];

interface Shipped {
  at: Date | null;
  release: string | null;
}

export interface ShipNoticeItem {
  id: string;
  route: string | null;
  phase: FeedbackPhase;
  reporterAgency: 'human' | 'agent';
}

/**
 * When and in which release each item's work shipped, off its carriers: the latest release one of them
 * was cut into, else the latest moment one was merged (a carrier closed by hand has no release).
 */
async function shippedOf(feedbackIds: readonly string[]): Promise<Map<string, Shipped>> {
  const carriers = await db
    .select({
      feedbackId: feedbackRouteIssues.feedbackId,
      mergedAt: issues.mergedAt,
      closedAt: issues.updatedAt,
      version: pipelineRuns.releaseVersion,
      releasedAt: pipelineRuns.releaseReleasedAt,
    })
    .from(feedbackRouteIssues)
    .innerJoin(issues, eq(issues.id, feedbackRouteIssues.issueId))
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(
      and(inArray(feedbackRouteIssues.feedbackId, [...feedbackIds]), ne(issues.status, 'dropped')),
    );
  const out = new Map<string, Shipped>();
  for (const c of carriers) {
    const latest = out.get(c.feedbackId) ?? { at: null, release: null };
    const at = c.releasedAt ?? c.mergedAt ?? c.closedAt;
    if (latest.at === null || at > latest.at) {
      out.set(c.feedbackId, { at, release: c.releasedAt ? c.version : null });
    }
  }
  return out;
}

/** The first moment a shipped release put `release.shipped` on the outbox; null before any did. */
async function noticesBegan(): Promise<Date | null> {
  const [first] = await db
    .select({ at: sql<Date | null>`min(${pipelineOutbox.createdAt})` })
    .from(pipelineOutbox)
    .where(eq(pipelineOutbox.type, 'release.shipped'));
  return first?.at == null ? null : new Date(first.at);
}

interface SentNotice {
  feedbackId: string;
  at: Date;
  delivered: number;
  release: string | null;
}

/** The latest release notice written for each item, with how many bells it reached and its release. */
async function noticesOf(feedbackIds: readonly string[]): Promise<Map<string, SentNotice>> {
  const rows = await db
    .select({
      dedupeKey: notifications.dedupeKey,
      createdAt: notifications.createdAt,
      delivered: sql<number>`(SELECT count(*)::int FROM ${notificationDeliveryMembers} m WHERE m.notification_id = ${notifications.id})`,
    })
    .from(notifications)
    .where(
      or(
        ...feedbackIds.map((id) => like(notifications.dedupeKey, `${feedbackShippedPrefix(id)}%`)),
      ),
    )
    .orderBy(desc(notifications.createdAt));
  const out = new Map<string, SentNotice & { runId: string }>();
  for (const r of rows) {
    const id = feedbackIds.find((f) => r.dedupeKey?.startsWith(feedbackShippedPrefix(f)));
    if (!id || out.has(id)) continue;
    const runId = r.dedupeKey?.slice(feedbackShippedPrefix(id).length) ?? '';
    out.set(id, { feedbackId: id, at: r.createdAt, delivered: r.delivered, release: null, runId });
  }
  const runIds = [...new Set([...out.values()].map((n) => n.runId).filter(Boolean))];
  const runs = runIds.length
    ? await db
        .select({ id: pipelineRuns.id, version: pipelineRuns.releaseVersion })
        .from(pipelineRuns)
        .where(inArray(pipelineRuns.id, runIds))
    : [];
  const versions = new Map(runs.map((r) => [r.id, r.version]));
  for (const n of out.values()) n.release = versions.get(n.runId) ?? null;
  return out;
}

interface SentMessage {
  feedbackId: string;
  at: Date;
  by: string;
  relayed: boolean;
}

/** Every message to reporters on these items, newest first: a bell's or, with no recipient, a relay. */
async function reporterMessagesOf(feedbackIds: readonly string[]): Promise<SentMessage[]> {
  const rows = await db
    .select({
      feedbackId: feedbackMessages.feedbackId,
      at: feedbackMessages.createdAt,
      by: feedbackMessages.sentBy,
      recipients: feedbackMessages.recipients,
    })
    .from(feedbackMessages)
    .where(
      and(
        inArray(feedbackMessages.feedbackId, [...feedbackIds]),
        ne(feedbackMessages.audience, 'internal'),
      ),
    )
    .orderBy(desc(feedbackMessages.createdAt));
  return rows.map((r) => ({ ...r, relayed: r.recipients.length === 0 }));
}

function untoldReason(
  item: ShipNoticeItem,
  notice: SentNotice | undefined,
  shipped: Shipped,
  before: boolean,
): string {
  if (notice) {
    return 'The reporter has turned this notice off, so it reached nobody: tell them yourself.';
  }
  if (item.reporterAgency === 'agent') {
    return 'The reporter is an agent, which has no bell: tell it where it listens.';
  }
  if (before) return 'It shipped before Forge told reporters when a release shipped.';
  return shipped.release
    ? `${shipped.release} shipped it and sent the reporter no notice.`
    : 'No release carries it, so none told the reporter: tell them yourself.';
}

/**
 * Each shipped item's notice: told by the release's notice, else by a message or relay sent since the
 * work shipped, else why nobody told the reporter. Items that have not shipped read null.
 */
export async function shipNoticesOf(
  items: readonly ShipNoticeItem[],
): Promise<Map<string, FeedbackShipNotice | null>> {
  const out = new Map<string, FeedbackShipNotice | null>(items.map((i) => [i.id, null]));
  const shippedItems = items.filter((i) => i.route === 'issue' && SHIPPED_PHASES.includes(i.phase));
  if (shippedItems.length === 0) return out;
  const ids = shippedItems.map((i) => i.id);
  const [shipped, notices, messages, began] = await Promise.all([
    shippedOf(ids),
    noticesOf(ids),
    reporterMessagesOf(ids),
    noticesBegan(),
  ]);
  const names = await userNames(messages.map((m) => m.by));
  for (const item of shippedItems) {
    const ship = shipped.get(item.id) ?? { at: null, release: null };
    const notice = notices.get(item.id);
    if (notice && notice.delivered > 0) {
      out.set(item.id, {
        state: 'told',
        how: 'notice',
        at: notice.at.toISOString(),
        release: notice.release,
        by: null,
        shipped: { at: ship.at?.toISOString() ?? null, release: ship.release ?? notice.release },
      });
      continue;
    }
    const since = ship.at;
    const message = messages.find(
      (m) => m.feedbackId === item.id && (since === null || m.at >= since),
    );
    if (message) {
      out.set(item.id, {
        state: 'told',
        how: message.relayed ? 'relayed' : 'message',
        at: message.at.toISOString(),
        release: ship.release,
        by: names.get(message.by) ?? null,
        shipped: { at: ship.at?.toISOString() ?? null, release: ship.release },
      });
      continue;
    }
    const before =
      !notice && item.reporterAgency === 'human' && ship.at !== null && began !== null
        ? ship.at < began
        : false;
    out.set(item.id, {
      state: 'not_told',
      reason: untoldReason(item, notice, ship, before),
      shipped: { at: ship.at?.toISOString() ?? null, release: ship.release },
      beforeNotices: before,
    });
  }
  return out;
}

export async function shipNoticeOf(item: ShipNoticeItem): Promise<FeedbackShipNotice | null> {
  return (await shipNoticesOf([item])).get(item.id) ?? null;
}

/**
 * Of items that read resolved on issues, those whose reporter nothing told, and who holds
 * feedback.approve by name (read only where one is owed): the relay `standing.ts` waits on.
 */
export async function relayOwedAmong(
  projectId: string,
  resolved: readonly Omit<ShipNoticeItem, 'phase'>[],
): Promise<{ untold: Set<string>; relayHolders: string[] }> {
  const untold = new Set<string>();
  if (resolved.length === 0) return { untold, relayHolders: [] };
  const notices = await shipNoticesOf(resolved.map((r) => ({ ...r, phase: 'resolved' })));
  for (const [id, n] of notices) if (n?.state === 'not_told') untold.add(id);
  return {
    untold,
    relayHolders: untold.size > 0 ? await holderNames('feedback.approve', projectId) : [],
  };
}
