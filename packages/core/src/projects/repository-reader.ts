/** What Forge asks of a project's repository, by binding or deploy key (ISS-1398). */

export const RANGE_COMMIT_LIMIT = 1000;

export type RepositoryRoute = 'binding' | 'deploy_key';

/** Why a read was refused, and the act that clears it held apart, so several causes say it once. */
export interface Refused {
  readonly cause: string;
  readonly clears?: string;
}

export function saying(refused: Refused): string {
  return refused.clears === undefined ? refused.cause : `${refused.cause} — ${refused.clears}`;
}

const HEX = /^[0-9a-f]+$/i;

/** The act a mark refused for its commit's name is told to take. */
export const MARK_WITH_WHOLE_SHA = 'Mark with the full 40-character sha the work landed at';

/**
 * Why `name` names no commit in `repository`, whose commits are named by `whole` hex digits, or
 * null. Git (once the commit is packed) and GitHub both answer a longer name by its leading digits,
 * so every reader rules on the length before a host is asked.
 */
export function overlongCommitName(name: string, whole: number, repository: string): string | null {
  const digits = name.trim().toLowerCase();
  if (!HEX.test(digits) || digits.length <= whole) return null;
  return (
    `${repository} holds no commit ${digits}: it is ${digits.length} hex digits, and a commit ` +
    `there is named by its ${whole}-digit sha or a prefix of it`
  );
}

/** `overlongCommitName` as the absent answer a commit lookup gives. */
export function overlongLookup(name: string, why: string, repository: string): CommitLookup {
  return {
    kind: 'absent',
    detail: `${why}. ${MARK_WITH_WHOLE_SHA}`,
    details: { commit: name, repository },
  };
}

export interface FoundCommit {
  sha: string;
  message: string;
  /** First parent first, as git records them. */
  parents: string[];
  committedAt: string | null;
}

export type CommitLookup =
  | ({ kind: 'found' } & FoundCommit)
  | { kind: 'absent'; detail: string; details: Record<string, unknown> }
  | { kind: 'unreadable'; why: string };

/** A read that failed; `missingBranch` where the cause is a branch the repository does not have. */
export interface ReadFailure {
  why: string;
  missingBranch?: string;
}

export type BranchRead = { sha: string } | ReadFailure;

export type Containment = { contains: boolean } | ReadFailure;

export type Carriage =
  | { readonly kind: 'descends' }
  /** `paths`: every file the two trees may differ in, each side's since their merge base. */
  | { readonly kind: 'differs'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string; readonly clears?: string };

export type ChangedPaths =
  | { readonly kind: 'read'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string; readonly clears?: string };

export interface RangeCommit {
  sha: string;
  parents: string[];
  message: string;
}

/** Every commit `head` holds that `base` does not, oldest first. */
export type RangeRead = { commits: RangeCommit[] } | { why: string };

export interface RepositoryReader {
  readonly name: string;
  readonly route: RepositoryRoute;
  commit(ref: string): Promise<CommitLookup>;
  branchHead(branch: string): Promise<BranchRead>;
  contains(sha: string, branch: string): Promise<Containment>;
  carriage(judged: string, served: string): Promise<Carriage>;
  changedPaths(landing: string): Promise<ChangedPaths>;
  range(base: string, head: string): Promise<RangeRead>;
}

export type RepositoryAccess =
  | { kind: 'reader'; reader: RepositoryReader }
  /** `unbound`: neither a GitHub binding nor a deploy key was declared. */
  | ({ kind: 'refused'; unbound: boolean; route: RepositoryRoute } & Refused);
