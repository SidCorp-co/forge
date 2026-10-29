/**
 * What Forge asks of the host a project's repository lives on, whichever host that is (ISS-50).
 *
 * Every lifecycle reader — whether a commit landed, what a deploy branch is missing, what an
 * artifact holds at a commit, the merge itself, and the agent's change-request verbs — asks through
 * this one shape, so none of them names GitHub or GitLab. A host is reached through an integration
 * declaration's `sourceHost` (`types.ts:IntegrationDeclaration`), resolved per project by
 * `resolve.ts`.
 */

import type { ChangeRequestHost, ProjectedCheckRun } from '../../db/schema-repo-projection.js';

export interface WaitingCommit {
  sha: string;
  message: string;
  parents: string[];
}

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

/**
 * A change request as its host answers for it now — the request a projection row is written from
 * when no webhook delivered it. `state` is `open`, `closed` or `merged`, merged kept apart from closed.
 */
export interface ReadChangeRequest extends OpenedChangeRequest {
  /** Its description: every issue key it names is an issue the request delivers (REQ-63 BC-4). */
  body: string | null;
  mergedAt: string | null;
  /** What landed, and only once it merged: GitHub names a test merge on an open request too. */
  mergeCommitSha: string | null;
}

/**
 * One check on a commit as its host reports it, in the shape the projection stores a webhook's:
 * a GitHub check run or commit status, a GitLab pipeline. One shape, so no reader forks on whether
 * a delivery or a read wrote it.
 */
export type HostCheck = ProjectedCheckRun;

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

/**
 * A landing as the host reports it: the commit that landed, when, and the branch it landed on (the
 * request's base). All three are the evidence an issue's merge stamp is written from, so a host that
 * reports a merge without one of them refuses `merged-without-evidence` rather than answer this.
 */
interface HostLanding {
  commitSha: string;
  mergedAt: Date;
  target: string;
  /** The request's head as the host reported it at the merge; null where it named none. */
  head: string | null;
}

export type HostMergeResult =
  | ({ kind: 'merged' } & HostLanding)
  | ({ kind: 'already-merged' } & HostLanding)
  | { kind: 'refused'; reason: string; detail: string };

/**
 * A tag as the host answers the ask to put `name` on a commit (REQ-63 BC-13, BC-14): `created` it,
 * found it `present` on that commit already, or found it on another commit, which is never moved.
 * `sha` is the commit the tag names on the host, an annotated tag read through to its commit.
 */
export type HostTagResult =
  | { kind: 'created'; name: string; sha: string }
  | { kind: 'present'; name: string; sha: string }
  | { kind: 'conflict'; name: string; sha: string };

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
  /** Whether two commits carry the same tree: the same files with the same bytes, whatever their history. */
  sameTree(a: string, b: string): Promise<boolean>;
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
  /**
   * Put the lightweight tag `name` on commit `sha`, as the binding's own credential. A tag of that
   * name already there is read, never moved: on `sha` it is `present`, elsewhere a `conflict`.
   */
  tagCommit(args: { name: string; sha: string }): Promise<HostTagResult>;

  /** Every check the host holds on one commit, each re-run its own entry; empty where none ran. */
  readChecks(sha: string): Promise<HostCheck[]>;
  /**
   * Every check the host holds for a change request at its head: the head commit's own, and on a
   * host that runs a pipeline for the request itself (a GitLab merge request pipeline, whose commit
   * is a merge ref rather than the head) that pipeline too, recorded at the head it ran for
   * (REQ-63 BC-7).
   */
  readChangeRequestChecks(args: { number: number; headSha: string }): Promise<HostCheck[]>;
  /** One change request by the number the host shows, whoever opened it. */
  readChangeRequest(number: number): Promise<ReadChangeRequest>;
  /** A new title, description or both, and the request as the host answers after the write. */
  updateChangeRequest(args: {
    number: number;
    title?: string;
    body?: string;
  }): Promise<ReadChangeRequest>;
  /**
   * Close an open change request without merging it. One already closed is answered as it stands;
   * a merged one is refused by name, since closing cannot undo a landing.
   */
  closeChangeRequest(args: { number: number }): Promise<ReadChangeRequest>;
}

/** What a declaration offers to build a host from a binding's own config and credential. */
export interface SourceHostFactory {
  /** The host's name as a person reads it — what the repository card on the Integrations page is labelled. */
  label: string;
  /** How the host writes a change request's number (`!12`, `#12`), read without a binding. */
  sigil: string;
  hostOf(config: Record<string, unknown>): string;
  build(args: {
    bindingId: string;
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
  }): SourceHost;
  /** What `GET /api/projects/:id/integrations/source` reports for this provider's bindings on a project. Contacts no host. */
  listBindings?(projectId: string): Promise<Array<{ provider: string } & Record<string, unknown>>>;
}
