/**
 * The ONE writer of a review's tracker record — ISS-1074, ISS-1062's outcome 5.
 *
 * Before this, a review existed twice and was reconciled by nothing: a reviewer's verdict went into
 * the tracker by hand and a GitHub review sat on the pull request, and neither knew about the other.
 * This function is the whole of the fix. Whichever side submitted the review — a person pressing
 * Submit on GitHub, or an agent calling `forge_github review` — the same call writes the same one
 * comment on the issue the pull request's head branch names.
 *
 * ## Why the idempotency key is the comment and not a column
 *
 * Two things had to be true at once, and only the marker gives both.
 *
 * A review can arrive before the `pull_request` delivery that would have created its projection
 * row — GitHub delivers unordered — and `applyReviewEvent` answers 0 for a row it cannot find. A
 * key stored on that row is therefore a key that is sometimes not there to store, and the first
 * review on a pull request Forge has never seen is exactly the case the tracker record matters
 * most for.
 *
 * And the App's own review may or may not come back to the App's own webhook. Writing at submit
 * time and relying on the echo not to double it is a bet on that; writing only on the echo is a bet
 * that it arrives. Keyed on the review id in the body, both paths are the same path, and neither
 * bet is taken.
 */

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

/**
 * The string that makes this review's comment findable, and findable by nothing else.
 *
 * In the visible body rather than an HTML comment: `prepareBody` sanitises markup on the way in, and
 * a key a sanitiser is entitled to remove is a key that silently stops deduplicating. Markdown
 * renders `[github-review:12345]` as its own text, because nothing defines that reference.
 */
export function reviewMarker(reviewId: string): string {
  return `[github-review:${reviewId}]`;
}

const VERDICT_WORD: Record<string, string> = {
  approved: 'approved',
  changes_requested: 'requested changes on',
  commented: 'commented on',
  dismissed: 'had a review dismissed on',
};

/** The comment a review becomes. The reviewer's own words are quoted, never paraphrased. */
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
  // cm:guard the id is checked to be digits before it reaches a LIKE pattern. GitHub sends an integer, so this fires on nothing today — and a `%` or `_` arriving in it would turn the duplicate check into a wildcard that matches some OTHER review's comment and silently drops this one. Refused by name rather than escaped, because there is no legitimate non-numeric id.
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
    // cm:guard said out loud rather than skipped. A project with no creator is a row this repo does not expect to exist, and a review that reached Forge and left no record because of it is the silent half of "one record instead of two" going missing.
    logger.warn(
      { projectId: args.projectId, issueId, reviewId: args.review.id },
      'github review note: project has no creator to attribute the comment to, so nothing was written',
    );
    return { outcome: 'no-author', issueId, commentId: null };
  }

  const marker = reviewMarker(args.review.id);
  // cm:guard the lock is on the ISSUE and it is what makes two doors one writer: the tool's own call and the App's webhook echo can land within milliseconds of each other, and a check-then-insert without it lets both find nothing and both write. The issue row is the right thing to lock because it is the one row both paths have resolved by the time they get here.
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
      .where(and(eq(comments.issueId, issueId), like(comments.body, `%${marker}%`)))
      .limit(1);
    if (already) {
      return { outcome: 'already-noted' as const, issueId, commentId: already.id };
    }

    const written = await insertComment(
      {
        issueId,
        authorId,
        authorDeviceId: null,
        // cm:guard `null` and not `human` or `agent`. The author is a GitHub identity, which is neither a Forge user at a keyboard nor a Forge agent session — `actor-agency.ts` calls that unestablished, and it is the honest answer for both doors. It also keeps the agent message screen off a third party's prose, which could otherwise refuse a write GitHub has already accepted and leave the review recorded on one side only.
        authorAgency: null,
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
