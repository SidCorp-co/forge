// feedback-triage `verify-ask`: an ask to verify a resolved item reaches its reporter's bell, and the
// verify or reopen of that item settles it. A decline, a merge into an original and a triager's
// message each reach their reporters as one notice, the text the event carries. The release that ships the work of an item tells its
// reporter in their language, naming the release and what it changed for them, once per item: a
// second release or a redelivery carrying the same item tells nobody twice.

import { feedbackKey } from '@forge/contracts/feedback';
import { feedbackShippedKey, feedbackShippedPrefix } from '@forge/contracts/notifications';
import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, notifications } from '../db/schema.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { noticeCopy, reporterLanguageOf } from '../feedback/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

const verifyKey = (feedbackId: string) => `feedback-verify:${feedbackId}`;

async function asked(p: Payload<'feedback.verifyAsked'>, eventId: string): Promise<void> {
  const language = await reporterLanguageOf(p.reporter, p.projectId);
  await emitNotification({
    recipients: [p.reporter],
    projectId: p.projectId,
    type: 'feedback_verify_asked',
    title: noticeCopy(language, 'verifyAsk.title', { key: p.key, title: p.title }),
    body: noticeCopy(language, 'verifyAsk.body', {}),
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
    title: p.title,
    body: p.body,
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
      // not skipped: the item reads not told, and its triagers owe the relay (`feedback/standing.ts`)
      logger.info(
        { feedback: key, project: p.projectId, release: p.version },
        'feedback: a shipped release closed an item whose reporter is an agent; its triagers owe the relay',
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
    const language = await reporterLanguageOf(item.reporter, p.projectId);
    await emitNotification({
      recipients: [item.reporter],
      projectId: p.projectId,
      type: 'feedback_shipped',
      title: noticeCopy(language, 'shipped.title', {
        key,
        version: p.version,
        title: item.title,
      }),
      body:
        said.length > 0
          ? said.join('\n')
          : noticeCopy(language, 'shipped.body', { version: p.version }),
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
