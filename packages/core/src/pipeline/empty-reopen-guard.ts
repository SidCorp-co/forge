/**
 * ISS-635 — Guard against dispatching forge-fix on a `reopen` with zero
 * prior implementation work. A `reopen` with no prior `code`/`fix` job has
 * no branch/commit for forge-fix to patch — dispatching it burns a runner
 * slot on a no-op. `considerEnqueue` routes this case to `needs_info`
 * instead; this module posts the operator-facing comment (mirrors the
 * `missing-skill-guard.ts` refuse+comment pattern).
 */

import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activityLog, comments } from '../db/schema.js';
import { logger } from '../logger.js';

export function buildEmptyReopenCommentBody(): string {
  return [
    '🛑 **`reopen` has no prior implementation to fix**',
    '',
    'This issue was reopened but has never had a `code` or `fix` job run — there is no ' +
      'branch or commit for forge-fix to patch.',
    '',
    'Routed to `needs_info` for human triage instead of dispatching an empty fix.',
  ].join('\n');
}

/**
 * Statuses a `reopen` can arrive from where the pipeline itself produced NO
 * rejection artifact. Every other origin (`testing`, `tested`, `developed`)
 * reaches `reopen` through a review/QA verdict, whose comment lands before the
 * transition (status-last discipline) and IS the thing forge-fix scopes against.
 */
const REOPEN_NEEDS_RATIONALE_FROM: ReadonlySet<string> = new Set(['released', 'closed']);

export interface UnexplainedReopen {
  /** The terminal status the issue was reopened out of. */
  from: string;
  /** When the issue entered that status — the window we searched for input. */
  since: Date;
}

/**
 * Was this issue reopened straight out of `released`/`closed` with nobody
 * saying why? forge-fix has nothing to scope a patch against then — it can only
 * re-derive "already shipped, no feedback" and bounce, burning a runner slot.
 *
 * Distinct from the empty-reopen guard above: there the issue never had an
 * implementation; here it shipped one and the reopen carries no rejection.
 *
 * cm:guard fails OPEN on every uncertainty (no history, unreadable window, any query error) — a false needs_info strands work a human is waiting on, which is far worse than the wasted run this catches
 */
export async function findUnexplainedReopen(issueId: string): Promise<UnexplainedReopen | null> {
  try {
    const [entered] = await db
      .select({ payload: activityLog.payload, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.issueId, issueId),
          eq(activityLog.action, 'issue.statusChanged'),
          sql`${activityLog.payload}->>'to' = 'reopen'`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    if (!entered) return null;

    const from = (entered.payload as { from?: string } | null)?.from;
    if (!from || !REOPEN_NEEDS_RATIONALE_FROM.has(from)) return null;

    // The window opens when the issue ENTERED that terminal status, so a
    // rationale counts whether the human wrote it before or after flipping.
    const [origin] = await db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.issueId, issueId),
          eq(activityLog.action, 'issue.statusChanged'),
          sql`${activityLog.payload}->>'to' = ${from}`,
          lt(activityLog.createdAt, entered.createdAt),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    // cm:why no recoverable window → fail open rather than guess one
    if (!origin) return null;

    const [input] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.issueId, issueId), gt(comments.createdAt, origin.createdAt)))
      .limit(1);
    if (input) return null;

    return { from, since: origin.createdAt };
  } catch (err) {
    logger.warn({ err, issueId }, 'empty-reopen-guard: unexplained-reopen check failed, allowing');
    return null;
  }
}

export function buildUnexplainedReopenCommentBody(from: string): string {
  return [
    '🛑 **`reopen` carries no reason**',
    '',
    `This issue was reopened out of \`${from}\` — its code already shipped — but no comment was posted explaining what regressed. forge-fix has nothing to scope a patch against.`,
    '',
    'Routed to `needs_info`. Add a comment describing the failure (what you did, what you ' +
      'expected, what happened) and set the issue back to `reopen` to dispatch the fix.',
  ].join('\n');
}

/**
 * Insert an operator-facing comment authored by the project creator
 * (audit-only, same convention as `postMissingSkillComment`). No-op when
 * the caller has no resolvable creator id.
 */
async function postGuardComment(
  issueId: string,
  authorId: string | null,
  body: string,
): Promise<void> {
  if (!authorId) return;
  try {
    await db.insert(comments).values({ issueId, authorId, body, isAi: true } as never);
  } catch (err) {
    logger.warn({ err, issueId }, 'empty-reopen-guard: failed to post comment, continuing');
  }
}

export async function postEmptyReopenComment(args: {
  issueId: string;
  authorId: string | null;
}): Promise<void> {
  await postGuardComment(args.issueId, args.authorId, buildEmptyReopenCommentBody());
}

export async function postUnexplainedReopenComment(args: {
  issueId: string;
  authorId: string | null;
  from: string;
}): Promise<void> {
  await postGuardComment(args.issueId, args.authorId, buildUnexplainedReopenCommentBody(args.from));
}
