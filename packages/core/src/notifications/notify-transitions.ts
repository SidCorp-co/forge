import type { NotificationSeverity } from '@forge/contracts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { logger } from '../logger.js';
import type { IssueStatus } from '../db/schema.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

/**
 * The curated set of `to`-statuses that surface an in-app notification for the
 * issue's assignee/owner. These are the moments a human cares about:
 * - `tested`  — parked at the manual release gate, needs a human to advance.
 * - `reopen`  — a regression / failed pipeline/deploy landed the issue back.
 * - `waiting` — parked for human review (decompose gate, exhausted retries).
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
  'pass',
  'staging',
  'released',
  'closed',
]);

/** Per-`to`-status severity for the `issue_status_changed` notification. */
function severityForStatus(to: IssueStatus): NotificationSeverity {
  switch (to) {
    case 'reopen':
      return 'error';
    case 'waiting':
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
    // Auto-resolve (ISS-510): reaching a healthy status clears any outstanding
    // `reopen`/`waiting` problem notification for this issue. Runs for ANY such
    // transition (even ones not in NOTIFY_ON_STATUS, e.g. `developed`), is
    // best-effort (never throws), and is idempotent (only unread rows match).
    if (HEALTHY_STATUSES.has(p.to)) {
      await resolveNotifications(statusResolutionKey(p.issueId));
    }

    if (!NOTIFY_ON_STATUS.has(p.to)) return;

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

      // Skip self-notify: don't ping someone about their own transition.
      if (p.actor.type === 'user' && p.actor.id === recipient) return;

      const displayId = `ISS-${row.issSeq}`;
      const label = row.title ? `${displayId} — ${row.title}` : displayId;

      await emitNotification({
        userId: recipient,
        projectId: p.projectId,
        type: 'issue_status_changed',
        title: `${label} moved to ${p.to}`,
        body: bodyForStatus(p.to, p.reason),
        issueId: p.issueId,
        severity: severityForStatus(p.to),
        // Only problem statuses carry a key so a later healthy transition can
        // auto-clear them; a `tested`/`closed` ping is informational (no key).
        resolutionKey: PROBLEM_STATUSES.has(p.to) ? statusResolutionKey(p.issueId) : null,
      });
    } catch (err) {
      logger.error(
        { err, issueId: p.issueId, to: p.to },
        'notify-transitions: emitNotification failed',
      );
    }
  });
}
