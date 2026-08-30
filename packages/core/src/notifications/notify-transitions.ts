import type { NotificationSeverity } from '@forge/contracts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues, notifications } from '../db/schema.js';
import { logger } from '../logger.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';
import type { HooksBus } from '../pipeline/hooks.js';
import { strandedResolutionKey } from '../pipeline/stranded-issues.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

/**
 * The curated set of `to`-statuses that surface an in-app notification for the
 * issue's assignee/owner. These are the moments a human cares about:
 * - `tested`  — parked at the manual release gate, needs a human to advance.
 * - `reopen`  — a regression / failed pipeline/deploy landed the issue back.
 * - `waiting` — parked for human review (decompose gate, exhausted retries).
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
  'released',
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

// cm:guard the park gets its OWN key, never `statusResolutionKey` — that one is per-ISSUE and shared with `reopen`/`waiting`, so clearing it when a question is answered would also clear a `waiting` park nobody addressed. One key per park, or answering one question silently discards another park's notification.
function questionResolutionKey(issueId: string): string {
  return `issue:${issueId}:question`;
}

/**
 * The auto-resolve key a notification for `to` carries, or `null` when the
 * ping is informational (`tested` / `closed`) and nothing later clears it.
 */
// cm:edge contract -> packages/core/src/pipeline/answer-resume.ts — the question key is only auto-resolvable because that module restarts THIS status on a human comment; point one of them at a different status and the notification carries a key nothing ever clears. Since the outbox hook carries the REWRITTEN status (ISS-886), an agent's `waiting` on an autonomous project now arrives here as `needs_info` and takes the question key rather than the `PROBLEM_STATUSES` one — correct, because that park is answerable, and the reason this branch must be read before the set below.
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
    // Auto-resolve (ISS-510): reaching a healthy status clears any outstanding
    // `reopen`/`waiting` problem notification for this issue. Runs for ANY such
    // transition (even ones not in NOTIFY_ON_STATUS, e.g. `developed`), is
    // best-effort (never throws), and is idempotent (only unread rows match).
    if (HEALTHY_STATUSES.has(p.to)) {
      await resolveNotifications(statusResolutionKey(p.issueId));
    }

    // cm:why ISS-762 — the stranded alarm asks a human to unpark; ANY move off `waiting` is that human answering, including a move to another unhealthy status. Gating this on HEALTHY_STATUSES would leave the alarm lit after the decision was made.
    if (p.to !== 'waiting') {
      await resolveNotifications(strandedResolutionKey(p.issueId));
    }

    // cm:why same shape as the stranded rule above, and for the same reason: a move OFF the park is the human answering. It cannot be gated on HEALTHY_STATUSES — `answer-resume.ts` restarts the driver at AUTONOMOUS_ENTRY_STATUS (`open`), which is not healthy and never becomes healthy, so a health-gated key would stay lit from the answer until `developed`.
    if (p.from === AUTONOMOUS_QUESTION_STATUS && p.to !== AUTONOMOUS_QUESTION_STATUS) {
      await resolveNotifications(questionResolutionKey(p.issueId));
    }

    if (!NOTIFY_ON_STATUS.has(p.to)) return;

    // cm:why ISS-849 — a redelivery of the same outbox row must not write a second notification; outboxId absent (any non-outbox emitter) skips this guard and leaves behavior unchanged
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
