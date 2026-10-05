import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import type { NotificationSeverity } from '@forge/contracts/notifications';
import { owedCloseResolutionKey, strandedResolutionKey } from '@forge/contracts/notifications';
import type { OutboxEventPayload } from '@forge/contracts/outbox-events';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues, notifications } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';
import { statusWords } from './subject.js';

const NOTIFY_ON_STATUS: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'awaiting_release',
  'reopen',
  'needs_info',
  'closed',
]);

/** Per-`to`-status severity for the `issue_status_changed` notification. */
function severityForStatus(to: IssueStatus): NotificationSeverity {
  switch (to) {
    case 'reopen':
      return 'error';
    case 'needs_info':
    case 'awaiting_release':
      return 'warning';
    case 'closed':
      return 'success';
    default:
      return 'info';
  }
}

/**
 * ISS-849 — redelivery-dedup key for one outbox event's delivery. Distinct from
 * {@link statusResolutionKey}: this collapses redeliveries of the SAME event, not per-issue
 * problem state.
 */
function transitionDedupeKey(eventId: string): string {
  return `transition:${eventId}`;
}

async function alreadyNotifiedTransition(dedupeKey: string): Promise<boolean> {
  try {
    const [existing] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.dedupeKey, dedupeKey))
      .limit(1);
    return Boolean(existing);
  } catch (err) {
    logger.error({ err, dedupeKey }, 'notify-transitions: transition dedupe lookup failed');
    return false;
  }
}

/** Per-status one-line body explaining why the recipient is being pinged. */
function bodyForStatus(to: IssueStatus, reason: string | null): string {
  if (reason && reason.trim().length > 0) return reason.trim();
  switch (to) {
    case 'awaiting_release':
      return 'Every criterion passed — ready for your release review.';
    case 'reopen':
      return 'Reopened — needs another look.';
    case 'needs_info':
      return 'Stopped on you — it cannot continue until you answer.';
    case 'closed':
      return 'Closed.';
    default:
      return `Moved to ${to}.`;
  }
}

/**
 * Wire issue status-transition fan-out: when an `issue.transitioned` event has a `to`
 * status in {@link NOTIFY_ON_STATUS}, insert one `issue_status_changed`
 * notification for the issue's assignee (falling back to its creator). The
 * insert emits `notification.created`, so the WS broadcaster delivers
 * `notification.created` to the recipient's user room with no reload.
 *
 * Self-notify is skipped — a user who drives their own issue forward is not
 * pinged about their own action.
 *
 * A failed notification insert is logged, never thrown, so it is not redelivered; the dedupe key
 * keeps a redelivery of the event from pinging twice.
 */
export function registerTransitionNotifications(): void {
  consume('issue.transitioned', {
    name: 'notify-transitions',
    handle: (p, d) => notifyTransition(p, d.eventId),
  });
}

async function notifyTransition(
  p: OutboxEventPayload<'issue.transitioned'>,
  eventId: string,
): Promise<void> {
  if (p.to !== 'needs_info') {
    await resolveNotifications(strandedResolutionKey(p.id));
  }

  if (ISSUE_TERMINAL_STATUSES.includes(p.to)) {
    await resolveNotifications(owedCloseResolutionKey(p.id));
  }

  if (!NOTIFY_ON_STATUS.has(p.to)) return;

  const dedupeKey = transitionDedupeKey(eventId);
  if (await alreadyNotifiedTransition(dedupeKey)) return;

  try {
    const [row] = await db
      .select({
        assigneeId: issues.assigneeId,
        createdById: issues.createdById,
        issSeq: issues.issSeq,
        title: issues.title,
      })
      .from(issues)
      .where(eq(issues.id, p.id))
      .limit(1);
    if (!row) return;

    const recipient = row.assigneeId ?? row.createdById;
    if (!recipient) return;

    if (p.actor.type === 'user' && p.actor.id === recipient) return;

    // Loaded on call: issues reaches this face at load through emitNotification.
    const { activeIssuePrefix } = await import('../issues/index.js');
    const displayId = formatIssueRef(await activeIssuePrefix(p.projectId), row.issSeq);
    const label = row.title ? `${displayId} — ${row.title}` : displayId;

    await emitNotification({
      userId: recipient,
      projectId: p.projectId,
      type: 'issue_status_changed',
      title: `${label} moved to ${statusWords(p.to)}`,
      body: bodyForStatus(p.to, p.reason),
      issueId: p.id,
      severity: severityForStatus(p.to),
      resolutionKey: null,
      dedupeKey,
    });
  } catch (err) {
    logger.error({ err, issueId: p.id, to: p.to }, 'notify-transitions: emitNotification failed');
  }
}
