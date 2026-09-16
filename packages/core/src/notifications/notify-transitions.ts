import type { NotificationSeverity } from '@forge/contracts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues, notifications } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { isTerminalPlacement } from '../pipeline/status-assertions.js';
import { owedCloseResolutionKey, strandedResolutionKey } from '../pipeline/stranded-issues.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

/**
 * The curated set of `to`-statuses that surface an in-app notification for the
 * issue's assignee/owner. These are the moments a human cares about:
 * - `tested`  — parked at the manual release gate, needs a human to advance.
 * - `reopen`  — a regression / failed pipeline/deploy landed the issue back.
 * - `waiting` — parked for a human (a decision, a resource only a person has).
 * - `needs_info` — the autonomous driver asked a question only a human can answer.
 * - `closed`  — the work shipped.
 *
 * `tested`/`reopen` also cover "pipeline failed" and "deploy result": those
 * outcomes manifest as one of these issue transitions, so the single
 * `transition` hook is the canonical surface (no Coolify-specific signal, no
 * `runId` — the schema's entityRef is `issueId`).
 */
const NOTIFY_ON_STATUS: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'tested',
  'reopen',
  'waiting',
  'needs_info',
  'closed',
]);

/**
 * Problem statuses whose notification carries an auto-resolve `resolutionKey`
 * (`issue:<id>:status`): once the issue reaches a {@link HEALTHY_STATUSES}
 * state the matching unread row is cleared automatically.
 */
const PROBLEM_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>(['reopen', 'waiting']);

/**
 * Healthy statuses that clear an outstanding `issue:<id>:status` problem
 * notification. Reaching any of these means the flagged condition is resolved.
 */
const HEALTHY_STATUSES: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  'developed',
  'testing',
  'tested',
  'awaiting_release',
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

/** Stable per-issue auto-resolve key for status-problem notifications. */
function statusResolutionKey(issueId: string): string {
  return `issue:${issueId}:status`;
}

function questionResolutionKey(issueId: string): string {
  return `issue:${issueId}:question`;
}

/**
 * The auto-resolve key a notification for `to` carries, or `null` when the
 * ping is informational (`tested` / `closed`) and nothing later clears it.
 */
function resolutionKeyForStatus(to: IssueStatus, issueId: string): string | null {
  if (to === AUTONOMOUS_QUESTION_STATUS) return questionResolutionKey(issueId);
  return PROBLEM_STATUSES.has(to) ? statusResolutionKey(issueId) : null;
}

/**
 * ISS-849 — redelivery-dedup key for a single outbox row's `transition`
 * delivery. Distinct from {@link statusResolutionKey}: this collapses
 * redeliveries of the SAME outbox row, not per-issue problem state.
 */
function transitionDedupeKey(outboxId: string): string {
  return `transition:${outboxId}`;
}

/**
 * True when an `issue_status_changed` notification already carries this
 * dedupe key, i.e. this delivery is a redelivery already recorded.
 * Best-effort, matching `subscribers.ts`'s `alreadyRecordedTransition`: a
 * lookup failure is logged and treated as "not a duplicate" so a transient
 * DB hiccup never suppresses the notification this subscriber exists to send.
 */
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
function bodyForStatus(to: IssueStatus, reason?: string): string {
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
      return `Moved to ${to}.`;
  }
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
    if (HEALTHY_STATUSES.has(p.to)) {
      await resolveNotifications(statusResolutionKey(p.issueId));
    }

    if (p.to !== 'waiting') {
      await resolveNotifications(strandedResolutionKey(p.issueId));
    }

    if (isTerminalPlacement(p.to)) {
      await resolveNotifications(owedCloseResolutionKey(p.issueId));
    }

    if (p.from === AUTONOMOUS_QUESTION_STATUS && p.to !== AUTONOMOUS_QUESTION_STATUS) {
      await resolveNotifications(questionResolutionKey(p.issueId));
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
        title: `${label} moved to ${p.to}`,
        body: bodyForStatus(p.to, p.reason),
        issueId: p.issueId,
        severity: severityForStatus(p.to),
        resolutionKey: resolutionKeyForStatus(p.to, p.issueId),
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
