/**
 * Operator-facing comments for the ISS-819 dispatch-side plan-gate guards in
 * `orchestrator.ts` (`considerEnqueue`). Dispatch-gate skips are otherwise
 * silent (no `job_events`), so an unexplained refusal reads as invisible
 * starvation — mirrors the `empty-reopen-guard.ts` refuse+comment pattern.
 */

import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import { logger } from '../logger.js';

export function buildMissingPlanCommentBody(args: {
  routedTo: 'clarified' | 'needs_info';
}): string {
  return [
    '🛑 **`approved` with no plan written**',
    '',
    'This issue reached `approved` — which normally means a plan was written and reviewed — with a blank `plan`.',
    '',
    args.routedTo === 'clarified'
      ? 'Routed back to `clarified` so a plan can be written before `code` dispatches.'
      : 'A `plan` job already ran and the plan is still blank — routing back to `clarified` would loop. Routed to `needs_info` for human triage instead.',
  ].join('\n');
}

export function buildNeedsInfoFixCommentBody(): string {
  return [
    '🛑 **`reopen` entered from `needs_info`**',
    '',
    'A fix cannot be scoped from an unanswered question — the open question still stands.',
    '',
    'Routed back to `needs_info` instead of dispatching `fix`.',
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
    logger.warn({ err, issueId }, 'plan-gate-guard: failed to post comment, continuing');
  }
}

export async function postMissingPlanComment(args: {
  issueId: string;
  authorId: string | null;
  routedTo: 'clarified' | 'needs_info';
}): Promise<void> {
  await postGuardComment(
    args.issueId,
    args.authorId,
    buildMissingPlanCommentBody({ routedTo: args.routedTo }),
  );
}

export async function postNeedsInfoReopenComment(args: {
  issueId: string;
  authorId: string | null;
}): Promise<void> {
  await postGuardComment(args.issueId, args.authorId, buildNeedsInfoFixCommentBody());
}
