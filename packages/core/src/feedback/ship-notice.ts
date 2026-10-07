// "Reporter told": whether the release that shipped an item's work told its reporter, read off the
// notice `notifications/notify-feedback.ts` wrote, never off a flag that could drift from it.

import type { FeedbackPhase, FeedbackShipNotice } from '@forge/contracts/feedback';
import { feedbackShippedPrefix } from '@forge/contracts/notifications';
import { desc, eq, like, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, notificationDeliveryMembers, notifications, pipelineRuns } from '../db/schema.js';
import { feedbackRouteIssues } from '../db/schema-feedback.js';
import { pipelineOutbox } from '../db/schema-outbox.js';

const SHIPPED_PHASES: readonly FeedbackPhase[] = ['resolved', 'verified'];

interface Shipped {
  at: Date | null;
  release: string | null;
}

/**
 * When and in which release the item's work shipped, off its carriers: the latest release one of them
 * was cut into, else the latest moment one was merged (a carrier closed by hand has no release).
 */
async function shippedOf(feedbackId: string): Promise<Shipped> {
  const carriers = await db
    .select({
      mergedAt: issues.mergedAt,
      closedAt: issues.updatedAt,
      version: pipelineRuns.releaseVersion,
      releasedAt: pipelineRuns.releaseReleasedAt,
    })
    .from(feedbackRouteIssues)
    .innerJoin(issues, eq(issues.id, feedbackRouteIssues.issueId))
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(eq(feedbackRouteIssues.feedbackId, feedbackId));
  let latest: Shipped = { at: null, release: null };
  for (const c of carriers) {
    const at = c.releasedAt ?? c.mergedAt ?? c.closedAt;
    if (latest.at === null || at > latest.at) {
      latest = { at, release: c.releasedAt ? c.version : null };
    }
  }
  return latest;
}

/** Whether `at` is before the first moment a shipped release put `release.shipped` on the outbox. */
async function beforeNoticesBegan(at: Date | null): Promise<boolean> {
  if (at === null) return false;
  const [first] = await db
    .select({ at: sql<Date | null>`min(${pipelineOutbox.createdAt})` })
    .from(pipelineOutbox)
    .where(eq(pipelineOutbox.type, 'release.shipped'));
  return first?.at != null && at < new Date(first.at);
}

export async function shipNoticeOf(
  feedbackId: string,
  item: { route: string | null; phase: FeedbackPhase; reporterAgency: 'human' | 'agent' },
): Promise<FeedbackShipNotice | null> {
  if (item.route !== 'issue' || !SHIPPED_PHASES.includes(item.phase)) return null;
  const [notice] = await db
    .select({
      createdAt: notifications.createdAt,
      dedupeKey: notifications.dedupeKey,
      delivered: sql<number>`(SELECT count(*)::int FROM ${notificationDeliveryMembers} m WHERE m.notification_id = ${notifications.id})`,
    })
    .from(notifications)
    .where(like(notifications.dedupeKey, `${feedbackShippedPrefix(feedbackId)}%`))
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  if (!notice || notice.delivered === 0) {
    const shipped = await shippedOf(feedbackId);
    const before =
      !notice && item.reporterAgency === 'human' && (await beforeNoticesBegan(shipped.at));
    return {
      state: 'not_told',
      reason: notice
        ? 'The reporter has turned this notice off, so it reached nobody: tell them yourself.'
        : item.reporterAgency === 'agent'
          ? 'The reporter is an agent, which has no bell: tell it where it listens.'
          : before
            ? 'It shipped before Forge told reporters when a release shipped.'
            : shipped.release
              ? `${shipped.release} shipped it and sent the reporter no notice.`
              : 'No release carries it, so none told the reporter: tell them yourself.',
      shipped: { at: shipped.at?.toISOString() ?? null, release: shipped.release },
      beforeNotices: before,
    };
  }
  const runId = notice.dedupeKey?.slice(feedbackShippedPrefix(feedbackId).length) ?? '';
  const [run] = await db
    .select({ version: pipelineRuns.releaseVersion })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId));
  return { state: 'told', at: notice.createdAt.toISOString(), release: run?.version ?? null };
}
