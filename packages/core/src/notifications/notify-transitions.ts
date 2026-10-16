import type { NotificationSeverity } from '@forge/contracts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues, notifications } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { ASSERTS_WORK_IN_PROGRESS, statusLabel } from '../issues/status-sets.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { strandResolutionKey } from '../pipeline/idle-candidates.js';
import { orphanedAssertionResolutionKey } from '../pipeline/issue-run-invariant.js';
import { isTerminalPlacement } from '../pipeline/status-assertions.js';
import { owedCloseResolutionKey, strandedResolutionKey } from '../pipeline/stranded-issues.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

const NOTIFY_ON_STATUS: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'tested',
  'reopen',
  'waiting',
  'needs_info',
  'closed',
]);

/** Per-`to`-status severity for the `issue_status_changed` notification. */
function severityForStatus(to: IssueStatus): NotificationSeverity {
  switch (to) {
    case 'reopen':
      return 'error';
    case 'waiting':
    case 'needs_info':
    case 'tested':
      return 'warning';
    case 'closed':
      return 'success';
    default:
      return 'info';
  }
}

/**
 * ISS-849 — redelivery-dedup key for a single outbox row's `transition`
 * delivery. Distinct from {@link statusResolutionKey}: this collapses
 * redeliveries of the SAME outbox row, not per-issue problem state.
 */
function transitionDedupeKey(outboxId: string): string {
  return `transition:${outboxId}`;
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
export function bodyForStatus(to: IssueStatus, reason?: string): string {
  if (reason && reason.trim().length > 0) return reason.trim();
  switch (to) {
    case 'tested':
      return 'Ready for your release review.';
    case 'reopen':
      return 'Reopened — needs another look.';
    case 'waiting':
      return 'Parked for your review.';
    case 'needs_info':
      return 'The driver asked a question — it cannot continue until you answer.';
    case 'closed':
      return 'Closed.';
    default:
      return `Moved to ${statusLabel(to)}.`;
  }
}

/** The notification's title: the issue, then the status it moved to as the screen names it. */
export function transitionTitle(issue: string, to: IssueStatus): string {
  return `${issue} moved to ${statusLabel(to)}`;
}

/**
 * Wire issue status-transition fan-out: when `transition` fires with a `to`
 * status in {@link NOTIFY_ON_STATUS}, insert one `issue_status_changed`
 * notification for the issue's assignee (falling back to its creator). The
 * insert emits `notificationCreated`, so the WS broadcaster delivers
 * `notification.created` to the recipient's user room with no reload.
 *
 * Self-notify is skipped — a user who drives their own issue forward is not
 * pinged about their own action.
 *
 * Best-effort by contract: failures are logged, never thrown — the originating
 * transition must succeed even if the notification insert blows up.
 */
export function registerTransitionNotifications(bus: HooksBus): void {
  bus.on('transition', async (p) => {
    // An idle notice names the status it was raised at, so any move ends it; a row still idle at
    // its new status is raised again once that status's own clock is spent.
    if (p.from !== p.to) await resolveNotifications(strandResolutionKey(p.issueId));

    if (p.to !== 'waiting') {
      await resolveNotifications(strandedResolutionKey(p.issueId));
    }

    if (!ASSERTS_WORK_IN_PROGRESS.includes(p.to)) {
      await resolveNotifications(orphanedAssertionResolutionKey(p.issueId));
    }

    if (isTerminalPlacement(p.to)) {
      await resolveNotifications(owedCloseResolutionKey(p.issueId));
    }

    if (!NOTIFY_ON_STATUS.has(p.to)) return;

    const dedupeKey = p.outboxId ? transitionDedupeKey(p.outboxId) : null;
    if (dedupeKey && (await alreadyNotifiedTransition(dedupeKey))) return;

    try {
      const [row] = await db
        .select({
          assigneeId: issues.assigneeId,
          createdById: issues.createdById,
          issSeq: issues.issSeq,
          title: issues.title,
        })
        .from(issues)
        .where(eq(issues.id, p.issueId))
        .limit(1);
      if (!row) return;

      const recipient = row.assigneeId ?? row.createdById;
      if (!recipient) return;

      if (p.actor.type === 'user' && p.actor.id === recipient) return;

      const displayId = formatIssueRef(await activeIssuePrefix(p.projectId), row.issSeq);
      const label = row.title ? `${displayId} — ${row.title}` : displayId;

      await emitNotification({
        userId: recipient,
        projectId: p.projectId,
        type: 'issue_status_changed',
        title: transitionTitle(label, p.to),
        body: bodyForStatus(p.to, p.reason),
        issueId: p.issueId,
        severity: severityForStatus(p.to),
        resolutionKey: null,
        dedupeKey,
      });
    } catch (err) {
      logger.error(
        { err, issueId: p.issueId, to: p.to },
        'notify-transitions: emitNotification failed',
      );
    }
  });
}
