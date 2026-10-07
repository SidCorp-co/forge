// "Feedback answered": the feedback items a release's issues carry, read for the release page, each
// with whether the release told its reporter (the notice `notify-feedback.ts` wrote for this run), or
// a person did once it shipped: a message to reporters, or a relay recorded for one no bell reaches.

import type { FeedbackRoute } from '@forge/contracts/feedback';
import { feedbackKey } from '@forge/contracts/feedback';
import { feedbackShippedKey } from '@forge/contracts/notifications';
import type { ReleaseFeedbackView } from '@forge/contracts/releases';
import { and, asc, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificationDeliveryMembers, notifications, pipelineRuns } from '../db/schema.js';
import { feedback, feedbackMessages, feedbackRouteIssues } from '../db/schema-feedback.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { userNames } from '../lib/people.js';
import { feedbackEgress, WITHHELD } from './egress.js';

const ISSUE_ROUTE: FeedbackRoute = 'issue';

/** The latest message or relay to each item's reporters sent since the release shipped. */
async function toldByPeople(
  runId: string,
  items: readonly { id: string }[],
): Promise<Map<string, Date>> {
  const [run] = await db
    .select({ at: pipelineRuns.releaseReleasedAt })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId));
  if (!run?.at) return new Map();
  const rows = await db
    .select({ id: feedbackMessages.feedbackId, at: feedbackMessages.createdAt })
    .from(feedbackMessages)
    .where(
      and(
        inArray(
          feedbackMessages.feedbackId,
          items.map((i) => i.id),
        ),
        ne(feedbackMessages.audience, 'internal'),
        gte(feedbackMessages.createdAt, run.at),
      ),
    )
    .orderBy(desc(feedbackMessages.createdAt));
  const out = new Map<string, Date>();
  for (const r of rows) if (!out.has(r.id)) out.set(r.id, r.at);
  return out;
}

/**
 * Every feedback item routed onto an issue of the release. `runId` is null for a draft: nothing has
 * been told yet, and each reads `on_ship`. A shipped release reads each item `told` off its notice or
 * `not_told`; one still being cut reads `on_ship` too, so the list never claims a silence early.
 */
export async function feedbackAnsweredBy(
  projectId: string,
  issueIds: readonly string[],
  release: { runId: string | null; shipped: boolean },
  agency: 'human' | 'agent',
): Promise<ReleaseFeedbackView[]> {
  if (issueIds.length === 0) return [];
  const items = await db
    .selectDistinct({
      id: feedback.id,
      seq: feedback.fbSeq,
      title: feedback.title,
      reporter: feedback.reportedBy,
      agency: feedback.reporterAgency,
    })
    .from(feedbackRouteIssues)
    .innerJoin(feedback, eq(feedback.id, feedbackRouteIssues.feedbackId))
    .where(
      and(
        inArray(feedbackRouteIssues.issueId, [...issueIds]),
        eq(feedback.projectId, projectId),
        eq(feedback.route, ISSUE_ROUTE),
      ),
    )
    .orderBy(asc(feedback.fbSeq));
  if (items.length === 0) return [];
  const { withhold } = feedbackEgress(await dataPolicyOf(projectId), agency);
  const names = await userNames(items.map((i) => i.reporter));
  const sent =
    release.shipped && release.runId
      ? await db
          .select({
            key: notifications.dedupeKey,
            at: notifications.createdAt,
            delivered: sql<number>`(SELECT count(*)::int FROM ${notificationDeliveryMembers} m WHERE m.notification_id = ${notifications.id})`,
          })
          .from(notifications)
          .where(
            inArray(
              notifications.dedupeKey,
              items.map((i) => feedbackShippedKey(i.id, release.runId as string)),
            ),
          )
      : [];
  const told = new Map(sent.map((n) => [n.key, n]));
  const relayed =
    release.shipped && release.runId
      ? await toldByPeople(release.runId, items)
      : new Map<string, Date>();
  return items.map((i) => {
    const key = feedbackKey(i.seq);
    const notice = release.runId ? told.get(feedbackShippedKey(i.id, release.runId)) : undefined;
    const byNotice = notice && notice.delivered > 0 ? notice.at : null;
    const at = byNotice ?? relayed.get(i.id) ?? null;
    const state: ReleaseFeedbackView['told'] = !release.shipped
      ? 'on_ship'
      : at
        ? 'told'
        : 'not_told';
    return {
      key,
      title: withhold ? `${key} (${WITHHELD})` : i.title,
      reporter: names.get(i.reporter) ?? 'The reporter',
      agency: i.agency,
      told: state,
      toldAt: state === 'told' && at ? at.toISOString() : null,
    };
  });
}
