import type { NotificationSeverity } from '@forge/contracts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { issues, notifications } from '../db/schema.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
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

/*
 * ISS-1063 — `PROBLEM_STATUSES`, `HEALTHY_STATUSES`, `statusResolutionKey`,
 * `questionResolutionKey` and `resolutionKeyForStatus` were DELETED here, not disabled.
 *
 * `issue_status_changed` is a `signal`: an issue moved, and an event cannot stop having
 * happened. It carried a condition's dedup key and a pair of clearers anyway, which is why
 * 1771 of its 5444 rows on the replica wore one and 3333 of the owner's 5663 open rows were
 * this type — a "condition" whose nature is never to resolve. The record layer now forbids
 * it structurally (a CHECK constraint refuses `resolution_key` on a signal row), so keeping
 * these helpers would mean computing a key the writer must then drop, which is the silent
 * substitution this issue is about.
 *
 * What replaced the behaviour they bought: the `needs_info` park reaches a human through
 * `GET /me/attention`'s `awaitingInput` bucket, which derives from LIVE issue state and so
 * self-clears when the question is answered. That bucket, not a read flag on a row, is the
 * durable surface — and it was already the one the product pointed people at.
 */

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
    // cm:why ISS-762 — the stranded alarm asks a human to unpark; ANY move off `waiting` is that human answering, including a move to another unhealthy status. Gating this on HEALTHY_STATUSES would leave the alarm lit after the decision was made.
    if (p.to !== 'waiting') {
      await resolveNotifications(strandedResolutionKey(p.issueId));
    }

    // cm:why ISS-940 — the owed-close alarm asks for a terminal placement and nothing else clears it; `unmark` clears the mark instead and leaves the alarm lit until the next sweep re-reads the predicate and auto-resolve is not the path for that
    if (isTerminalPlacement(p.to)) {
      await resolveNotifications(owedCloseResolutionKey(p.issueId));
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
        // cm:guard a signal carries NO resolution key, and `deliver.ts` refuses one by name rather than dropping it. Do not reintroduce a key here to make some reader clear a status ping: a status ping is not a condition, and the thing that clears is the issue's own state.
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
