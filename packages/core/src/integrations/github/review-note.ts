import { and, eq, like } from 'drizzle-orm';
import { insertComment } from '../../comments/service.js';
import { db } from '../../db/client.js';
import { comments, issues, projects } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { resolveIssueForHeadRef } from './issue-link.js';

/** One review, in the shape both doors already hold it in. */
export interface ReviewToNote {
  /** GitHub's own review id, as a string. Digits, and refused by name when it is not. */
  id: string;
  reviewer: string;
  /** `approved` | `changes_requested` | `commented`, as GitHub spells it. */
  state: string;
  submittedAt: string | null;
  url: string | null;
  /** What the reviewer wrote, which is the record this exists to keep. */
  body: string | null;
}

export type ReviewNoteOutcome =
  /** The comment was written by this call. */
  | 'written'
  /** A comment for this review id is already on the issue — the other door got there first. */
  | 'already-noted'
  /** The head branch names no issue on this project. An ordinary answer, never an error. */
  | 'no-issue'
  /** The issue's project has no creator to attribute a system comment to. */
  | 'no-author';

export interface ReviewNoteResult {
  outcome: ReviewNoteOutcome;
  issueId: string | null;
  commentId: string | null;
}

export function reviewMarker(reviewId: string): string {
  return `[github-review:${reviewId}]`;
}

/**
 * The LIKE pattern that finds a comment this function wrote for this review, and no other comment.
 *
 * Anchored to the end of the body, behind a newline, because that is the only place `reviewNoteBody`
 * ever puts the marker.
 */
function terminalMarkerPattern(reviewId: string): string {
  return `%\n${reviewMarker(reviewId)}`;
}

const VERDICT_WORD: Record<string, string> = {
  approved: 'approved',
  changes_requested: 'requested changes on',
  commented: 'commented on',
  dismissed: 'had a review dismissed on',
};

export function reviewNoteBody(args: {
  review: ReviewToNote;
  repository: string;
  number: number;
}): string {
  const { review } = args;
  const verb = VERDICT_WORD[review.state] ?? `left a \`${review.state}\` review on`;
  const where = review.url
    ? `[${args.repository}#${args.number}](${review.url})`
    : `${args.repository}#${args.number}`;
  const when = review.submittedAt ? ` at ${review.submittedAt}` : '';
  const head = `**${review.reviewer}** ${verb} ${where}${when}.`;
  const said = (review.body ?? '').trim();
  const quoted = said
    ? said
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    : '_No text, only the verdict._';
  return `## GitHub review\n\n${head}\n\n${quoted}\n\n${reviewMarker(review.id)}`;
}

/** The user a system comment is attributed to, as `webhooks/github-adapter.ts` attributes its own. */
async function projectCreator(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.createdBy ?? null;
}

/**
 * Write this review onto the issue its pull request's head branch names, once.
 *
 * Called from the `pull_request_review` projection arm and from `forge_github review`. Both of them
 * reach this and nothing else: "no second record" is a property of there being one function, not of
 * two call sites agreeing.
 */
export async function noteReviewOnIssue(args: {
  projectId: string;
  headRef: string;
  repository: string;
  number: number;
  review: ReviewToNote;
}): Promise<ReviewNoteResult> {
  if (!/^[0-9]+$/.test(args.review.id)) {
    throw new Error(
      `github review id \`${args.review.id}\` is not a number — a review is keyed on GitHub's own integer id and nothing else`,
    );
  }

  const issueId = await resolveIssueForHeadRef({
    projectId: args.projectId,
    headRef: args.headRef,
  });
  if (!issueId) return { outcome: 'no-issue', issueId: null, commentId: null };

  const authorId = await projectCreator(args.projectId);
  if (!authorId) {
    logger.warn(
      { projectId: args.projectId, issueId, reviewId: args.review.id },
      'github review note: project has no creator to attribute the comment to, so nothing was written',
    );
    return { outcome: 'no-author', issueId, commentId: null };
  }

  const pattern = terminalMarkerPattern(args.review.id);
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, issueId))
      .for('update')
      .limit(1);
    if (!locked) return { outcome: 'no-issue' as const, issueId: null, commentId: null };

    const [already] = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.issueId, issueId), like(comments.body, pattern)))
      .limit(1);
    if (already) {
      return { outcome: 'already-noted' as const, issueId, commentId: already.id };
    }

    const written = await insertComment(
      {
        issueId,
        authorId,
        authorDeviceId: null,
        body: reviewNoteBody({
          review: args.review,
          repository: args.repository,
          number: args.number,
        }),
        format: 'markdown',
        parentId: null,
      },
      tx,
    );
    return { outcome: 'written' as const, issueId, commentId: written.row.id };
  });
}
