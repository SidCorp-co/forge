// feedback-triage `verify-ask`: a resolved item waiting on its reporter reaches their bell, and the
// verify or reopen of that item settles it. A decline, a merge into an original and a triager's
// message each reach their reporters as one notice, the text the event carries. The release that
// ships the work of an item tells its reporter by itself (REQ-66 BC-8): the release, what its notes
// say changed for them, the violated criterion's verdict and clip — the kernel fact and words people
// wrote, no ask composed by core (ISS-857) — cleared like any verify ask once they verify or reopen.
// Once per item: a second release or a redelivery carrying the same item tells nobody twice.

import { feedbackKey } from '@forge/contracts/feedback';
import { feedbackShippedKey, feedbackShippedPrefix } from '@forge/contracts/notifications';
import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, notifications } from '../db/schema.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { shipEvidenceOf, shippedNotice, verifyAskNotice } from '../feedback/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

const verifyKey = (feedbackId: string) => `feedback-verify:${feedbackId}`;

/** A notice as the bell stores it: the fact as its title, a body only where somebody wrote one. */
const bellOf = (n: { title: string; body: string }) => ({ title: n.title, body: n.body || null });

async function asked(p: Payload<'feedback.verifyAsked'>, eventId: string): Promise<void> {
  await emitNotification({
    recipients: [p.reporter],
    projectId: p.projectId,
    type: 'feedback_verify_asked',
    ...bellOf(verifyAskNotice(p.key, p.title)),
    resolutionKey: verifyKey(p.feedbackId),
    dedupeKey: `feedback-verify-ask:${eventId}`,
  });
}

async function settled(p: Payload<'feedback.verifySettled'>): Promise<void> {
  await resolveNotifications(verifyKey(p.feedbackId), `${p.key} ${p.decision}`);
}

async function told(p: Payload<'feedback.reporterTold'>, eventId: string): Promise<void> {
  await emitNotification({
    recipients: p.recipients,
    projectId: p.projectId,
    type: 'feedback_message',
    ...bellOf(p),
    dedupeKey: `feedback-told:${eventId}`,
  });
}

async function shipped(p: Payload<'release.shipped'>): Promise<void> {
  if (p.issueIds.length === 0) return;
  const carried = await db
    .selectDistinct({ id: feedbackRouteIssues.feedbackId })
    .from(feedbackRouteIssues)
    .where(inArray(feedbackRouteIssues.issueId, p.issueIds));
  if (carried.length === 0) return;
  const items = await db
    .select({
      id: feedback.id,
      seq: feedback.fbSeq,
      title: feedback.title,
      reporter: feedback.reportedBy,
      agency: feedback.reporterAgency,
      violatedCriterionId: feedback.violatedCriterionId,
    })
    .from(feedback)
    .where(
      and(
        inArray(
          feedback.id,
          carried.map((c) => c.id),
        ),
        eq(feedback.projectId, p.projectId),
        eq(feedback.route, 'issue'),
      ),
    );
  for (const item of items) {
    const key = feedbackKey(item.seq);
    if (item.agency !== 'human') {
      // not skipped: an agent has no bell, and its own read of the item asks it to confirm or reopen
      // (`feedback/ship-notice.ts`, `feedback/standing.ts`)
      logger.info(
        { feedback: key, project: p.projectId, release: p.version },
        'feedback: a shipped release closed an item whose reporter is an agent; its read of the item asks it to confirm',
      );
      continue;
    }
    const carriers = await db
      .select({
        id: issues.id,
        status: issues.status,
        notes: issues.releaseNotes,
      })
      .from(feedbackRouteIssues)
      .innerJoin(issues, eq(issues.id, feedbackRouteIssues.issueId))
      .where(eq(feedbackRouteIssues.feedbackId, item.id));
    const stillOwed = carriers.filter((c) => c.status !== 'dropped' && c.status !== 'closed');
    if (stillOwed.length > 0) continue;
    const [already] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(like(notifications.dedupeKey, `${feedbackShippedPrefix(item.id)}%`))
      .limit(1);
    if (already) continue;
    // what changed for them is the release note's user-facing line, never an issue's own title
    const said = carriers
      .filter((c) => p.issueIds.includes(c.id))
      .map((c) => c.notes?.userFacing?.trim())
      .filter((t): t is string => Boolean(t));
    const evidence = await shipEvidenceOf({ projectId: p.projectId, ...item });
    await emitNotification({
      recipients: [item.reporter],
      projectId: p.projectId,
      type: 'feedback_shipped',
      ...bellOf(shippedNotice(key, item.title, p.version, said, evidence)),
      // the item waits on its reporter's verify or reopen, which clears it as an asked verify is
      resolutionKey: verifyKey(item.id),
      dedupeKey: feedbackShippedKey(item.id, p.runId),
    });
  }
}

export function registerFeedbackNotifications(): void {
  const name = 'notify-feedback';
  consume('feedback.verifyAsked', { name, handle: (p, d) => asked(p, d.eventId) });
  consume('feedback.verifySettled', { name, handle: settled });
  consume('feedback.reporterTold', { name, handle: (p, d) => told(p, d.eventId) });
  consume('release.shipped', { name, handle: shipped });
}
