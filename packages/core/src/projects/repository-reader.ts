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
