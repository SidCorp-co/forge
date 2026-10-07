/** What Forge asks of a project's repository, by binding or deploy key (ISS-1398). */

export const RANGE_COMMIT_LIMIT = 1000;

export type RepositoryRoute = 'binding' | 'deploy_key';

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

export type Containment = { contains: boolean } | { why: string };

export type Carriage =
  | { readonly kind: 'descends' }
  /** `paths`: every file the two trees may differ in, each side's since their merge base. */
  | { readonly kind: 'differs'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string };

export type ChangedPaths =
  | { readonly kind: 'read'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string };

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
  branchHead(branch: string): Promise<{ sha: string } | { why: string }>;
  contains(sha: string, branch: string): Promise<Containment>;
  carriage(judged: string, served: string): Promise<Carriage>;
  changedPaths(landing: string): Promise<ChangedPaths>;
  range(base: string, head: string): Promise<RangeRead>;
}

export type RepositoryAccess =
  | { kind: 'reader'; reader: RepositoryReader }
  /** `unbound`: neither a GitHub binding nor a deploy key was declared. */
  | { kind: 'refused'; why: string; unbound: boolean; route: RepositoryRoute };
