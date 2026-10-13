// What a project that ships by version tag owes a close (ISS-1391, ADR 0004): a tag matching its
// declared pattern contains the issue's landing commit. The rule reads the project's repository
// and so runs before the transition's transaction opens, never inside it.

import { eq } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { type IssueStatus, issues, projects } from '../db/schema.js';
import { chainReleaseTag } from '../projects/release-chain.js';
import { withRepository } from '../projects/repository-access.js';
import { saying, type TagContainment } from '../projects/repository-reader.js';
import { TransitionError } from './transition-error.js';

/** Where a tag-released issue rests until a tag that contains it is cut. */
export const RELEASE_TAG_RESTING_STATUS: IssueStatus = 'awaiting_release';

export interface ReleaseTagRefusal {
  code: 'CLOSE_REQUIRES_RELEASE_TAG' | 'RELEASE_TAG_UNREAD';
  detail: string;
  details: Record<string, unknown>;
}

/** The glob a project's last chain entry names its release tags by, or `null` where it names none. */
export async function releaseTagOf(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ releaseChain: projects.releaseChain })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ? chainReleaseTag(row.releaseChain) : null;
}

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The commit this issue's work landed as: the one Forge observed, else the one a caller claimed; `lock` holds the row until the transaction ends. */
async function landingCommitOf(issueId: string, executor: Pick<Db, 'select'> = db, lock = false) {
  const read = executor
    .select({ observed: issues.mergedCommitSha, claimed: issues.mergedClaimedCommit })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  const [row] = await (lock ? read.for('update') : read);
  const commit = (row?.observed ?? row?.claimed ?? '').trim();
  return commit === '' ? null : commit;
}

const DROPPED_FOR_NON_WORK =
  'Use `dropped` for work that turned out not to be work: a note, a question, a duplicate, something already done.';

function noLandingRefusal(pattern: string): ReleaseTagRefusal {
  return {
    code: 'CLOSE_REQUIRES_RELEASE_TAG',
    detail:
      `this project ships by version tag, so \`closed\` means a tag matching \`${pattern}\` contains the commit the work landed as, and this issue carries no landing commit to look for in one. ` +
      'Mark it merged naming the commit it landed at (`forge_issues` `mark_merged`, `data.commit`); it rests at `awaiting_release` until a tag contains that commit. ' +
      DROPPED_FOR_NON_WORK,
    details: {
      requires: 'releaseTag',
      pattern,
      landing: null,
      rests: RELEASE_TAG_RESTING_STATUS,
      useInstead: 'dropped',
    },
  };
}

function unreadRefusal(pattern: string, landing: string, why: string): ReleaseTagRefusal {
  return {
    code: 'RELEASE_TAG_UNREAD',
    detail:
      `this project ships by version tag, so \`closed\` means a tag matching \`${pattern}\` contains the landing commit ${landing}, and the tags could not be read: ${why}. ` +
      'Nothing was closed, and a tag list that could not be read is not read as one holding no tag. ' +
      'Fix what let the read fail (a GitHub binding whose installation can read the repository, or the deploy key attached under Git access), then close again.',
    details: { requires: 'releaseTag', pattern, landing, read: 'unread', why },
  };
}

function notContainedRefusal(pattern: string, read: Extract<TagContainment, { commit: string }>) {
  const newest = read.matching[0] ?? null;
  const standing =
    newest === null
      ? 'no tag matching it exists yet'
      : `none of the ${read.matching.length} tag(s) matching it does, the newest being \`${newest}\``;
  const refusal: ReleaseTagRefusal = {
    code: 'CLOSE_REQUIRES_RELEASE_TAG',
    detail:
      `this project ships by version tag, so \`closed\` means a tag matching \`${pattern}\` contains the landing commit ${read.commit}, and ${standing}. ` +
      `The issue rests at \`${RELEASE_TAG_RESTING_STATUS}\` until a tag that contains it is cut and deployed; once one is, close it again and nothing else needs editing. ` +
      DROPPED_FOR_NON_WORK,
    details: {
      requires: 'releaseTag',
      pattern,
      landing: read.commit,
      newestTag: newest,
      matchingTags: read.matching.length,
      rests: RELEASE_TAG_RESTING_STATUS,
      useInstead: 'dropped',
    },
  };
  return refusal;
}

/** What judging a close found: why it is refused, or the commit whose tag was read to allow it. */
interface Judgement {
  refusal: ReleaseTagRefusal | null;
  /** Set only where a tag held the commit, so the transaction can hold the issue to it. */
  carried: string | null;
}

const NOT_APPLICABLE: Judgement = { refusal: null, carried: null };

async function judge(
  issue: { id: string; projectId: string },
  toStatus: IssueStatus,
): Promise<Judgement> {
  if (toStatus !== 'closed') return NOT_APPLICABLE;
  const pattern = await releaseTagOf(issue.projectId);
  if (pattern === null) return NOT_APPLICABLE;

  const landing = await landingCommitOf(issue.id);
  if (landing === null) return { refusal: noLandingRefusal(pattern), carried: null };

  let read: TagContainment;
  try {
    read = await withRepository(issue.projectId, async (access) =>
      access.kind === 'reader'
        ? access.reader.tagsContaining(landing, pattern)
        : ({ why: saying(access) } satisfies TagContainment),
    );
  } catch (err) {
    read = { why: err instanceof Error ? err.message : String(err) };
  }
  if ('why' in read) return { refusal: unreadRefusal(pattern, landing, read.why), carried: null };
  if (read.containing.length > 0) return { refusal: null, carried: landing };
  return { refusal: notContainedRefusal(pattern, read), carried: null };
}

/**
 * Refuses a close that a project shipping by version tag is not owed, and otherwise returns
 * `options` holding the issue, inside the transaction, to the landing commit whose tag was read: a
 * mark cleared and made again while the repository was being read would otherwise close on a commit
 * no tag was shown to hold. A project naming no tag, and any status but `closed`, change nothing.
 */
export async function holdReleaseTagClose<
  O extends { beforeStatusWrite?: ((tx: Transaction) => Promise<void>) | undefined },
>(issue: { id: string; projectId: string }, toStatus: IssueStatus, options: O): Promise<O> {
  const { refusal, carried } = await judge(issue, toStatus);
  if (refusal) throw new TransitionError(refusal.code, refusal.detail, refusal.details);
  if (carried === null) return options;
  return {
    ...options,
    beforeStatusWrite: async (tx: Transaction) => {
      if ((await landingCommitOf(issue.id, tx, true)) !== carried) {
        throw new TransitionError(
          'STALE_TRANSITION',
          `the landing commit this issue's close was judged on (${carried}) changed while the repository's tags were being read, so the close was not made. Read where the issue stands now and close it again.`,
          { requires: 'releaseTag', judged: carried },
        );
      }
      await options.beforeStatusWrite?.(tx);
    },
  };
}
