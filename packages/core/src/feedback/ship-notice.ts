// "Reporter told": whether the release that shipped an item's work told its reporter, read off the
// notice `notifications/notify-feedback.ts` wrote, never off a flag that could drift from it.

import type { FeedbackPhase, FeedbackShipNotice } from '@forge/contracts/feedback';
import { feedbackShippedPrefix } from '@forge/contracts/notifications';
import { desc, eq, like, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificationDeliveryMembers, notifications, pipelineRuns } from '../db/schema.js';

const SHIPPED_PHASES: readonly FeedbackPhase[] = ['resolved', 'verified'];

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
  if (!notice) {
    return {
      state: 'not_told',
      reason:
        item.reporterAgency === 'agent'
          ? 'The reporter is an agent, which has no bell: tell it where it listens.'
          : 'No release has told the reporter yet.',
    };
  }
  if (notice.delivered === 0) {
    return {
      state: 'not_told',
      reason: 'The reporter has turned this notice off, so it reached nobody: tell them yourself.',
    };
  }
  const runId = notice.dedupeKey?.slice(feedbackShippedPrefix(feedbackId).length) ?? '';
  const [run] = await db
    .select({ version: pipelineRuns.releaseVersion })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId));
  return { state: 'told', at: notice.createdAt.toISOString(), release: run?.version ?? null };
}
