import { z } from 'zod';
import { describeOperation, fail, json } from '../api-reference/declare/describe.js';
import { mergeMarkSchema } from './search-reference.js';

export const mergeMarkAnswerSchema = z.object({
  id: z.string(),
  action: z.enum(['merged', 'already_merged', 'unmarked']),
  mark: mergeMarkSchema,
  detail: z.string(),
  /** The commit the landing moved forward from, where this mark moved it; null on every other answer. */
  movedFrom: z.string().nullable(),
});

export const mergePullRequestAnswerSchema = z.object({
  id: z.string(),
  merged: z.literal(true),
  alreadyMerged: z.boolean(),
  commitSha: z.string(),
  mergedAt: z.string(),
  stamped: z.boolean(),
  deliveryId: z.string(),
});

const NOT_A_WRITER = fail('FORBIDDEN', 'the caller is not a project member with write access');

const MARK_REFUSALS = {
  NO_WORK_EVIDENCE: 'the issue holds no evidence of work to mark as shipped',
  UNMARK_REQUIRES_NOT_CLOSED: 'a closed issue cannot be unmarked',
  NOT_MARKED_MERGED: 'the issue holds no merge mark, so an unmark has nothing to remove',
  LANDING_REQUIRED:
    'the work lands outside git, Forge holds no merged pull request, and `landing` was not sent',
  LANDING_NOT_THIS_SHAPE: '`landing` was sent for an issue whose work lands in git',
  MARK_ALREADY_STANDS: 'a mark already stands and names another landing; the first mark stands',
  PROJECT_KIND_UNKNOWN: 'the project declares no kind, so where its work lands cannot be told',
  LANDING_SHAPE_MOVED: "the issue's landing shape changed while the mark was being written",
  COMMIT_NOT_IN_REPOSITORY: 'the commit is not in the repository',
  COMMIT_NOT_THIS_ISSUE: "the commit is not this issue's work",
  COMMIT_NOT_LANDED: 'the commit has not landed on the base branch',
  COMMIT_UNVERIFIED: 'Forge cannot read the repository to check the commit',
  LANDING_NOT_DESCENDANT:
    "the commit does not descend from the one the issue's mark holds, so it is a different landing",
};

const describeMark = (summary: string, description: string) =>
  describeOperation({
    summary,
    description,
    responses: {
      200: json(
        mergeMarkAnswerSchema,
        '`mark` and `detail` say which kind of record this call left',
      ),
      400: fail('BAD_REQUEST', 'the project asks for a `target` and none was sent'),
      403: NOT_A_WRITER,
      404: fail('NOT_FOUND', 'the issue does not exist'),
      422: fail(MARK_REFUSALS),
    },
  });

export const markMerged = describeMark(
  'Say that the work of an issue shipped',
  "A claim, not an operation: it records somebody's word, and a commit when one is named. Releases the issues this one blocks.",
);

export const unmarkMerged = describeMark(
  'Take back the claim that the work of an issue shipped',
  'Refused once the issue is closed.',
);

export const mergePullRequest = describeOperation({
  summary: "Merge an issue's pull request as the GitHub App",
  description:
    "Writes the merge mark and the commit in the same operation. Without `pullRequest` the issue's one open pull request is merged; a head that moved since `headSha` is refused, never re-aimed.",
  responses: {
    200: json(
      mergePullRequestAnswerSchema,
      '`alreadyMerged` is true when the pull request had merged before this call',
    ),
    400: fail('BAD_REQUEST', 'the merge input was refused'),
    403: NOT_A_WRITER,
    404: fail('NOT_FOUND', 'the issue or the pull request does not exist'),
    422: fail({
      NO_PULL_REQUEST:
        'the issue has no such pull request, or several open ones and none was named',
      PROJECTION_EMPTY: "Forge's projection of the repository holds no pull requests at all",
      MERGE_REFUSED: 'the pull request cannot be merged; the message says why',
      NO_BINDING: 'the project has no GitHub binding to merge through',
    }),
  },
});
