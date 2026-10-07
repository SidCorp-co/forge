/**
 * What Forge asks of the host a project's repository lives on, whichever host that is (ISS-50).
 *
 * Every lifecycle reader — whether a commit landed, what a deploy branch is missing, what an
 * artifact holds at a commit, the merge itself, and the agent's change-request verbs — asks through
 * this one shape, so none of them names GitHub or GitLab. A host is reached through an integration
 * declaration's `sourceHost` (`types.ts:IntegrationDeclaration`), resolved per project by
 * `resolve.ts`.
 */

import type { ChangeRequestHost } from '../../db/schema-repo-projection.js';

export interface WaitingCommit {
  sha: string;
  message: string;
  parents: string[];
}

export type LiveDivergence =
  | {
      ok: true;
      baseSha: string;
      liveSha: string;
      aheadBy: number;
      commits: WaitingCommit[];
      /** False where `commits` holds fewer than `aheadBy`: an issue it does not name is unplaced. */
      complete: boolean;
    }
  | { ok: false; reason: string };

/** The commits `head` holds that `base` does not, oldest first as the host lists them. */
export type HostRange =
  | { ok: true; commits: WaitingCommit[]; complete: boolean }
  | { ok: false; reason: string };

export interface HostCommit {
  sha: string;
  message: string;
  committedAt: string | null;
}

/** Where `head` stands against `base`. `ahead` and `identical` both mean head contains base. */
export type HostCompare = 'ahead' | 'behind' | 'identical' | 'diverged';

/** A compare taken only whole: where head stands, and every file its tree differs from base's in
 *  since their merge base, a rename by both its names; or why the list cannot be taken whole. */
export type HostFileCompare =
  | {
      readonly status: HostCompare;
      readonly files: readonly string[];
      readonly changes: readonly HostFileChange[];
    }
  | { readonly why: string };

/** One file a compare names and what happened to it; a rename is its old path removed and its new one added. */
export interface HostFileChange {
  readonly path: string;
  readonly change: 'added' | 'changed' | 'removed';
}

/** The files one commit changed against its first parent, or why they cannot be named whole. */
export type HostCommitFiles =
  | { readonly files: readonly string[]; readonly changes: readonly HostFileChange[] }
  | { readonly why: string };

export interface ChangeRequestDiff {
  number: number;
  repository: string;
  bytes: number;
  truncated: boolean;
  diff: string;
}

export interface CheckLog {
  checkRunId: number;
  name: string;
  app: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  summary: string | null;
  log: string | null;
  truncated: boolean;
  refusal: string | null;
}

export interface WrittenComment {
  commentId: number;
  url: string | null;
}

export interface OpenedChangeRequest {
  /** The pull request number, or the merge request iid — what the host shows a person. */
  number: number;
  url: string | null;
  title: string;
  state: string;
  draft: boolean;
  headRef: string;
  headSha: string | null;
  baseRef: string;
  baseSha: string | null;
  updatedAt: string | null;
}

export interface RequestedReview {
  number: number;
  requestedReviewers: string[];
  requestedTeams: string[];
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface SubmittedReview {
  reviewId: number;
  state: string;
  url: string | null;
  submittedAt: string | null;
  reviewer: string;
  headRef: string;
  number: number;
  repository: string;
}

export interface HostMergeArgs {
  number: number;
  expectedHeadSha?: string | undefined;
  method?: string | undefined;
}

export type HostMergeResult =
  | { kind: 'merged'; commitSha: string; mergedAt: Date }
  | { kind: 'already-merged'; commitSha: string; mergedAt: Date }
  | { kind: 'refused'; reason: string; detail: string };

/** The host's own words, so a sentence about a change request says what a person sees there. */
interface SourceHostWords {
  changeRequest: string;
  sigil: string;
  /** The merge methods the host has. Anything else is refused by name, never defaulted. */
  mergeMethods: readonly string[];
}

export interface SourceHost {
  /** The integration provider serving this host, which is also the projection's `host`. */
  readonly provider: ChangeRequestHost;
  readonly bindingId: string;
  /** The repository's path on its host: `owner/repo`, or a GitLab `group/sub/project`. */
  readonly fullName: string;
  readonly host: string;
  readonly words: SourceHostWords;

  /** One commit, or null where the host resolves the ref to no single commit there. */
  readCommit(ref: string): Promise<HostCommit | null>;
  branchHead(branch: string): Promise<string>;
  compare(base: string, head: string): Promise<HostCompare>;
  compareFiles(base: string, head: string): Promise<HostFileCompare>;
  commitFiles(sha: string): Promise<HostCommitFiles>;
  /** Whether `branch` contains `sha`. */
  branchContains(branch: string, sha: string): Promise<boolean>;
  readDivergence(refs: BranchRefs): Promise<LiveDivergence>;
  /** The commits between two commits (any refs the host resolves), never named by branch. */
  readRange(base: string, head: string): Promise<HostRange>;
  /** A file's text at `ref`, held to the blob id the host names, or why there is none. */
  readFile(path: string, ref: string, maxBytes: number): Promise<string | { missing: string }>;

  diff(args: { number: number; maxBytes?: number }): Promise<ChangeRequestDiff>;
  checkLog(args: { checkRunId: number; lines?: number }): Promise<CheckLog>;
  comment(args: { number: number; body: string }): Promise<WrittenComment>;
  openChangeRequest(args: {
    head: string;
    base: string;
    title: string;
    body?: string;
    draft?: boolean;
  }): Promise<OpenedChangeRequest>;
  requestReview(args: {
    number: number;
    reviewers?: string[];
    teamReviewers?: string[];
  }): Promise<RequestedReview>;
  submitReview(args: {
    number: number;
    event: ReviewEvent;
    body: string;
  }): Promise<SubmittedReview>;
  merge(args: HostMergeArgs): Promise<HostMergeResult>;
}

/** What a declaration offers to build a host from a binding's own config and credential. */
export interface SourceHostFactory {
  /** The host's name as a person reads it — what the repository card on the Integrations page is labelled. */
  label: string;
  hostOf(config: Record<string, unknown>): string;
  build(args: {
    bindingId: string;
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
  }): SourceHost;
  /** What `forge_source list` reports for this provider's bindings on a project. Contacts no host. */
  listBindings?(projectId: string): Promise<Array<{ provider: string } & Record<string, unknown>>>;
}

/** The two branches a divergence read compares: what base holds that live lacks. */
export interface BranchRefs {
  baseRef: string;
  liveRef: string;
}
