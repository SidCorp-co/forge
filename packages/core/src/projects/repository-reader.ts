/**
 * What Forge asks of a project's repository, whichever way it reads it (ISS-1398): through the
 * project's GitHub binding (`integrations/github/repository-reader.ts`), or with plain git over the
 * SSH deploy key attached to it (`git/repository-reading.ts`). `projects/repository-access.ts`
 * decides which. Every answer that could not be read is a reason, never an answer: a failed read
 * is not "contains".
 */

/** The most commits one release range is read to, so the most landings a batch can be asked to decide. */
export const RANGE_COMMIT_LIMIT = 1000;

/** Which route reads the repository, and so which one a refusal tells the reader to repair. */
export type RepositoryRoute = 'github' | 'deploy_key';

/** A commit the repository holds under a name. */
export interface FoundCommit {
  sha: string;
  message: string;
  /** First parent first, as git records them. */
  parents: string[];
  /** The committer date as the repository gives it, or null where it gives none. */
  committedAt: string | null;
}

export type CommitLookup =
  | ({ kind: 'found' } & FoundCommit)
  | { kind: 'absent'; detail: string; details: Record<string, unknown> }
  | { kind: 'unreadable'; why: string };

/** Whether a branch contains a commit, or why it could not be read. */
export type Containment = { contains: boolean } | { why: string };

/** What a served commit holds of a judged one. */
export type Carriage =
  /** The served commit is the judged one or a descendant of it. */
  | { readonly kind: 'descends' }
  /** It is not: `paths` is every file the two trees may differ in, each side's since their merge base. */
  | { readonly kind: 'differs'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string };

/** The files a landing changed against its first parent. */
export type ChangedPaths =
  | { readonly kind: 'read'; readonly paths: readonly string[] }
  | { readonly kind: 'unread'; readonly why: string };

export interface RangeCommit {
  sha: string;
  /** First parent first, as git records them. */
  parents: string[];
  message: string;
}

/** Every commit `head` holds that `base` does not, oldest first, or why they could not be read. */
export type RangeRead = { commits: RangeCommit[] } | { why: string };

export interface RepositoryReader {
  /** The repository as a sentence names it: `owner/repo`, or the remote URL. */
  readonly name: string;
  readonly route: RepositoryRoute;
  /** The commit `ref` names, a full or abbreviated sha. */
  commit(ref: string): Promise<CommitLookup>;
  /** The commit a branch's head is at. */
  branchHead(branch: string): Promise<{ sha: string } | { why: string }>;
  /** Whether `branch` holds `sha`, which the repository already resolved. */
  contains(sha: string, branch: string): Promise<Containment>;
  carriage(judged: string, served: string): Promise<Carriage>;
  changedPaths(landing: string): Promise<ChangedPaths>;
  /** `base` is a branch name, `head` a commit. */
  range(base: string, head: string): Promise<RangeRead>;
}

/** What a caller is handed: a reader, or why there is none. */
export type RepositoryAccess =
  | { kind: 'reader'; reader: RepositoryReader }
  | {
      kind: 'refused';
      why: string;
      /** No route was declared at all: neither a GitHub binding nor a deploy key. */
      unbound: boolean;
      route: RepositoryRoute;
    };
