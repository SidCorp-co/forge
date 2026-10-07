// feedback-triage `verify-ask`: an ask to verify a resolved item reaches its reporter's bell, and the
// verify or reopen of that item settles it. A decline, a merge into an original and a triager's
// message each reach their reporters as one notice, the text the event carries. The release that ships the work of an item tells its
// reporter, naming the release and what it changed for them, once per item and release.

import { feedbackKey } from '@forge/contracts/feedback';
import { feedbackShippedKey } from '@forge/contracts/notifications';
import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

const verifyKey = (feedbackId: string) => `feedback-verify:${feedbackId}`;

async function asked(p: Payload<'feedback.verifyAsked'>, eventId: string): Promise<void> {
  await emitNotification({
    recipients: [p.reporter],
    projectId: p.projectId,
    type: 'feedback_verify_asked',
    title: `${p.key} is resolved: ${p.title}`,
    body: 'The work your feedback asked for has shipped. Verify the fix, or reopen the item saying what it does not answer.',
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
      logger.warn(
        { feedback: key, project: p.projectId, release: p.version },
        'feedback: a shipped release closed an item whose reporter is an agent, which has no bell to tell',
      );
      continue;
    }
    const carriers = await db
      .select({
        id: issues.id,
        status: issues.status,
        title: issues.title,
        notes: issues.releaseNotes,
      })
      .from(feedbackRouteIssues)
      .innerJoin(issues, eq(issues.id, feedbackRouteIssues.issueId))
      .where(eq(feedbackRouteIssues.feedbackId, item.id));
    const stillOwed = carriers.filter((c) => c.status !== 'dropped' && c.status !== 'closed');
    if (stillOwed.length > 0) continue;
    const here = carriers.filter((c) => p.issueIds.includes(c.id));
    const said = here
      .map((c) => c.notes?.userFacing ?? c.title)
      .filter((t): t is string => Boolean(t));
    await emitNotification({
      recipients: [item.reporter],
      projectId: p.projectId,
      type: 'feedback_shipped',
      title: `${key} shipped in ${p.version}: ${item.title}`,
      body:
        said.length > 0
          ? said.join('\n')
          : `${p.version} carries the work your feedback asked for.`,
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
