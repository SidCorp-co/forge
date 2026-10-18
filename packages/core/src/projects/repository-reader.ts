/** What Forge asks of a project's repository, by binding or deploy key (ISS-1398). */

export const RANGE_COMMIT_LIMIT = 1000;

export type RepositoryRoute = 'binding' | 'deploy_key';

/** Why a read was refused, the act that clears it, and the host's own words, each held apart. */
export interface Refused {
  readonly cause: string;
  readonly clears?: string;
  readonly said?: string;
}

const asSentence = (part: string): string => {
  const text = part.trim();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`.replace(/([^.!?])$/, '$1.');
};

/** The cause, then the act that clears it, as sentences; the host's own line beneath them. */
export function saying(refused: Refused): string {
  const ours = [refused.cause, refused.clears].flatMap((p) => (p ? [asSentence(p)] : [])).join(' ');
  return refused.said ? `${ours}\n${refused.said}` : ours;
}

/** The cause inside a sentence of ours, where a line of its own cannot go: the host's words after a colon. */
export function inClause(refused: Omit<Refused, 'clears'>): string {
  return refused.said ? `${refused.cause}: ${refused.said}` : refused.cause;
}

const HEX = /^[0-9a-f]+$/i;

export const MARK_WITH_WHOLE_SHA = 'Mark with the full 40-character sha the work landed at';

/** Why `name` is too long to name a commit, which git (once packed) and GitHub would still answer
 *  by its leading `whole` digits; every reader asks this before a host. */
export function overlongCommitName(name: string, whole: number, repository: string): string | null {
  const digits = name.trim().toLowerCase();
  if (!HEX.test(digits) || digits.length <= whole) return null;
  return (
    `${repository} holds no commit ${digits}: it is ${digits.length} hex digits, and a commit ` +
    `there is named by its ${whole}-digit sha or a prefix of it`
  );
}

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

/** `containing` may stop at the first tag found, so it shows that one exists and is no census. */
export type TagContainment =
  | { commit: string; containing: string[]; matching: string[] }
  | ReadFailure;

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
  descends(ancestor: string, head: string): Promise<Containment>;
  tagsContaining(commit: string, pattern: string): Promise<TagContainment>;
  carriage(judged: string, served: string): Promise<Carriage>;
  changedPaths(landing: string): Promise<ChangedPaths>;
  range(base: string, head: string): Promise<RangeRead>;
}

export type RepositoryAccess =
  | { kind: 'reader'; reader: RepositoryReader }
  /** `unbound`: neither a GitHub binding nor a deploy key was declared. */
  | ({ kind: 'refused'; unbound: boolean; route: RepositoryRoute } & Refused);
