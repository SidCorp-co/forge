// Two signals, one notification, because they mean the same thing: a `waiting`
// park nobody was told about.
//
// On a STAGED project the signal is a contradiction — the code is on the base
// branch and the issue still says it is not done (ISS-762). Nothing weaker
// separates "parked on purpose, nothing at stake" from "parked on a question
// nobody heard", so the merge is required there.
//
// On an AUTONOMOUS project the park itself is the signal and no merge is
// needed. There is no next step to notice: `answer-resume.ts` restarts
// `needs_info` and nothing else, so a human must act or the issue stops
// forever. ISS-886 rewrote an AGENT's `waiting` away, which leaves exactly the
// two kinds this pass now has to surface — a person's own park, and the
// decompose review gate. Measured 2026-08-30: kinetrak ISS-4's split had been
// waiting 11 days with nobody told.
//
// Detection + notify only. This pass never moves an issue: `waiting` is a
// deliberate human park and only a human may leave it. The whole point is to
// tell that human a decision is owed.

import { and, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, notifications, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { projectAdminUserIds } from '../notifications/project-admins.js';

/**
 * How long an issue may sit `waiting` with merged code before it is stranded.
 *
 * A legitimate merge → verify → close pass takes minutes, so this is not a race
 * with the happy path. It is deliberately far below the daily sweep that found
 * the first case at 29h, and far below the 7–12 days the three known cases
 * actually sat.
 */
export const STRANDED_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * How long a surfaced park stays surfaced before it may ping again.
 *
 * The dedupe below keys on an UNREAD notification, so reading one re-arms it —
 * intended, because a park still unresolved a day later is still owed a
 * decision. What makes that safe is this window: the sweep runs every 60s, so
 * without it "read" means "pinged again within the minute", every minute, for
 * the life of the park.
 */
// cm:guard this MUST stay wider than the sweep interval (`pipeline/sweeper.ts`, 60s) by a large margin, and it is what bounds the autonomous arm below: that arm matches EVERY `waiting` park past the grace window rather than the rare merged-and-parked contradiction the staged arm needs, so the population this pass notifies about grew by roughly the number of parked issues on the fleet. A cooldown at or below the sweep interval reintroduces exactly the per-tick storm.
export const STRANDED_RENOTIFY_MS = 24 * 60 * 60 * 1000;

export interface StrandedIssuesResult {
  /** Issues matching the stranded predicate this tick. */
  detected: number;
  /** Notifications actually inserted (0 when every one was already surfaced). */
  notified: number;
}

export function strandedResolutionKey(issueId: string): string {
  return `issue:${issueId}:stranded`;
}

/**
 * Surface every `waiting` park that is past {@link STRANDED_GRACE_MS} and has
 * nothing coming for it. Best-effort: never throws — a failure here must not
 * abort the sweep.
 */
// cm:guard the age is measured from `merged_at` on staged and from `updated_at` on autonomous, and the two are NOT interchangeable: an autonomous park has no merge to date it from, and dating a staged one by `updated_at` would restart the clock every time a comment or a label touched the row.
export async function detectStrandedIssues(
  now: Date = new Date(),
  scope: { projectId?: string } = {},
): Promise<StrandedIssuesResult> {
  try {
    const cutoff = new Date(now.getTime() - STRANDED_GRACE_MS);

    const rows = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        issSeq: issues.issSeq,
        title: issues.title,
        mergedAt: issues.mergedAt,
        updatedAt: issues.updatedAt,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.status, 'waiting'),
          or(
            and(isNotNull(issues.mergedAt), lt(issues.mergedAt, cutoff)),
            and(
              // cm:edge contract -> packages/core/src/pipeline/autonomous-project.ts — the SAME mode question that `isAutonomousProject` answers, asked in SQL because this pass is one set-based scan over every project and an async per-row helper cannot appear in a `WHERE`. Read as jsonb the shape must match `pipelineConfigSchema.mode`; the two disagreeing means a park is surfaced on one mode and not the other, silently, and only this arm decides who gets told.
              sql`${projects.agentConfig}->'pipelineConfig'->>'mode' = 'autonomous'`,
              lt(issues.updatedAt, cutoff),
            ),
          ),
          ...(scope.projectId ? [eq(issues.projectId, scope.projectId)] : []),
        ),
      );

    let notified = 0;
    let unreachable = 0;
    for (const row of rows) {
      const resolutionKey = strandedResolutionKey(row.id);

      // cm:guard `resolved_at IS NULL` is the OUTER condition and must stay outside the `or` — it is what "this strand is still the one we alarmed about" means (db/schema.ts says every reader owes this column, never `read`). A resolved row is a strand that ENDED: the human moved the issue off `waiting` and `notifications/auto-resolve.ts` stamped it. Suppressing on that row would mute a genuine RE-strand for the rest of the window — ~16h of silence indistinguishable from no strand, in the module whose whole job is breaking silence.
      // cm:guard inside the `or`, unread **or** recently sent, never existence alone — existence alone surfaces a park once and never again, and unread alone re-pings every 60s tick from the moment a human reads it. Reading means "seen", not "resolved", so it stops suppressing; {@link STRANDED_RENOTIFY_MS} is what stops "seen" meaning "tell me again this minute".
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'issue_stranded'),
            eq(notifications.resolutionKey, resolutionKey),
            isNull(notifications.resolvedAt),
            or(
              eq(notifications.read, false),
              gte(notifications.createdAt, new Date(now.getTime() - STRANDED_RENOTIFY_MS)),
            ),
          ),
        )
        .limit(1);
      if (existing) continue;

      const ref = row.issSeq !== null ? `ISS-${row.issSeq}` : 'An issue';
      const since = row.mergedAt ?? row.updatedAt;
      const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
      const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : 'hours';
      const lead = row.mergedAt
        ? `Its code merged ${age} ago but the issue is still parked`
        : `It has been parked ${age}`;

      const adminIds = await projectAdminUserIds(row.projectId);
      if (adminIds.length === 0) unreachable += 1;
      for (const userId of adminIds) {
        await emitNotification({
          userId,
          projectId: row.projectId,
          issueId: row.id,
          type: 'issue_stranded',
          title: `${ref} is waiting on you — ${row.projectName}`,
          body: `${lead}, so nothing will move it forward until you decide. Open it and read the last comment: a step that could not finish its checks leaves the decision here.`,
          resolutionKey,
        });
        notified += 1;
      }
    }

    // cm:guard gated on `notified`, NOT on `detected` — a park already surfaced is not news, and this runs every 60s against a predicate that matches every parked issue on an autonomous project. Logging the detection instead reprints the same issue ids each minute for as long as the park lasts, which buries the tick where something actually changed.
    // cm:guard `unreachable` is the second arm and is NOT redundant: a project with no admin at all (`projectAdminUserIds` returns none) notifies nobody, so gating on `notified` alone would make the one case where the alarm reaches NO human the one case that also prints nothing.
    if (notified > 0 || unreachable > 0) {
      logger.warn(
        { detected: rows.length, notified, unreachable, issueIds: rows.map((r) => r.id) },
        'stranded-issues: a waiting park with nothing coming for it',
      );
    }

    return { detected: rows.length, notified };
  } catch (err) {
    logger.error({ err }, 'stranded-issues: detection failed');
    return { detected: 0, notified: 0 };
  }
}
