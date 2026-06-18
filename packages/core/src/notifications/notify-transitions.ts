import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { logger } from '../logger.js';
import type { IssueStatus } from '../db/schema.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { createNotification } from './routes.js';

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

      await createNotification({
        userId: recipient,
        projectId: p.projectId,
        type: 'issue_status_changed',
        title: `${label} moved to ${p.to}`,
        body: bodyForStatus(p.to, p.reason),
        issueId: p.issueId,
      });
    } catch (err) {
      logger.error(
        { err, issueId: p.issueId, to: p.to },
        'notify-transitions: createNotification failed',
      );
    }
  });
}
