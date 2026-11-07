// What the host holds before a merge is sent, and after one whose outcome it never confirmed
// (ISS-1114). adminhub-api !5197, 2026-11-07: the merge timed out, GitLab read the request back
// `closed` although it had merged it as 346580aa, and a retry merged head 3791e8dc a second time
// (5077e8ae). A request's own state is not enough: whether the target branch already contains its
// head is read from the host, and a head it contains is the landing, never a reason to merge again.
// adminhub-api 0.16.0 (FB-571): a release's promotion request whose head moved after approval
// would have merged at the new head; a release merge is held to the head core pinned for it.

import type { HostMergeResult, ReadChangeRequest, SourceHost } from './types.js';

type Refused = Extract<HostMergeResult, { kind: 'refused' }>;
type AlreadyMerged = Extract<HostMergeResult, { kind: 'already-merged' }>;

/** How many commits a moved-head refusal names one by one before it counts the rest. */
const NAMED_COMMITS = 10;

/** The head a release merge is held to, and who pinned it: the approval's commit or the cut's head. */
export interface ReleasePin {
  sha: string;
  runId: string;
  pinnedBy: 'approval' | 'cut';
}

/** The landing of a head the target branch contains, or why it cannot be named. */
export type LandingOnTarget =
  | { kind: 'found'; commitSha: string; mergedAt: Date; target: string; head: string }
  | { kind: 'unread'; why: string };

const refused = (reason: string, detail: string): Refused => ({ kind: 'refused', reason, detail });

const short = (sha: string) => sha.slice(0, 12);

/**
 * The commit that landed `head` on `target`: the first commit the target holds past the head with
 * the head among its parents (a merge commit), else the head itself (a fast-forward). Its time is
 * the commit's own, read from the host.
 */
export async function landingOnTarget(
  host: SourceHost,
  target: string,
  head: string,
): Promise<LandingOnTarget> {
  const sha = head.toLowerCase();
  const range = await host.readRange(sha, target);
  if (!range.ok) {
    return {
      kind: 'unread',
      why: `the commits ${target} holds past ${short(sha)}: ${range.reason}`,
    };
  }
  const merge = range.commits.find((c) => c.parents.some((p) => p.toLowerCase() === sha));
  if (!merge && !range.complete) {
    return {
      kind: 'unread',
      why: `${host.provider} listed part of the commits ${target} holds past ${short(sha)}, and none in it merged that head`,
    };
  }
  const commitSha = (merge?.sha ?? sha).toLowerCase();
  const read = await host.readCommit(commitSha);
  const mergedAt = read?.committedAt ? new Date(read.committedAt) : null;
  if (!mergedAt || Number.isNaN(mergedAt.getTime())) {
    return { kind: 'unread', why: `${host.provider} named no time for ${short(commitSha)}` };
  }
  return { kind: 'found', commitSha, mergedAt, target, head: sha };
}

/**
 * Whether the target branch already holds the request's head, read on the host; and where it does,
 * the landing. `null` where it does not. A read that fails is thrown to the caller, who names it.
 */
export async function landedOnTarget(
  host: SourceHost,
  read: Pick<ReadChangeRequest, 'baseRef' | 'headSha'>,
): Promise<LandingOnTarget | null> {
  const head = read.headSha?.toLowerCase() ?? '';
  if (!head || !read.baseRef) {
    return { kind: 'unread', why: `${host.provider} named no head or target branch` };
  }
  if (!(await host.branchContains(read.baseRef, head))) return null;
  return landingOnTarget(host, read.baseRef, head);
}

/** The commits between the pinned head and the head the request carries now, named for a refusal. */
async function commitsBetween(host: SourceHost, pin: string, head: string): Promise<string> {
  let range: Awaited<ReturnType<SourceHost['readRange']>>;
  try {
    range = await host.readRange(pin, head);
  } catch (err) {
    range = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (!range.ok) return `The commits between them could not be read (${range.reason}).`;
  const named = range.commits
    .slice(0, NAMED_COMMITS)
    .map((c) => `${short(c.sha)} ${c.message.split('\n')[0] ?? ''}`.trim());
  const more = range.commits.length - named.length;
  const count = range.commits.length;
  return `${count} commit${count === 1 ? '' : 's'} between them: ${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}

/** The refusal of a release merge whose request carries another head than the one core pinned. */
async function movedHead(
  host: SourceHost,
  named: string,
  pin: ReleasePin,
  head: string,
): Promise<Refused> {
  const pinned = pin.pinnedBy === 'approval' ? 'its approval names' : 'it was cut at';
  return refused(
    'release-head-moved',
    `${named}'s head is ${head}, and release run ${pin.runId} merges only ${pin.sha}, the head ${pinned}. ${await commitsBetween(host, pin.sha, head)} Nothing was merged: abort the release and cut it again, or have the new head approved.`,
  );
}

/**
 * The read before a merge is sent: the request as the host answers for it now, a release's head
 * against its pin, and whether the target already contains the head. `send` where the merge may go;
 * an already-merged landing where the target holds it; otherwise a named refusal, sent nowhere.
 */
export async function readBeforeMerge(
  host: SourceHost,
  number: number,
  pin: ReleasePin | null,
): Promise<{ kind: 'send' } | AlreadyMerged | Refused> {
  const named = `${host.words.changeRequest} ${host.words.sigil}${number}`;
  let read: ReadChangeRequest;
  try {
    read = await host.readChangeRequest(number);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return refused(
      'merge-precheck-unread',
      `${named} could not be read on ${host.provider} before merging (${why}), so whether its target already holds it is unknown. Nothing was sent; merge again once ${host.provider} answers.`,
    );
  }
  // a request the host itself reports merged is answered by the host's merge, with its evidence
  if (read.state === 'merged') return { kind: 'send' };
  const head = read.headSha?.toLowerCase() ?? '';
  if (pin && head !== pin.sha.toLowerCase()) {
    return movedHead(host, named, pin, head || 'unknown');
  }
  let landed: LandingOnTarget | null;
  try {
    landed = await landedOnTarget(host, read);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return refused(
      'merge-containment-unread',
      `${host.provider} could not say whether \`${read.baseRef}\` already holds ${named}'s head (${why}). Nothing was sent, so it is never merged twice; merge again once ${host.provider} answers.`,
    );
  }
  if (landed === null) return { kind: 'send' };
  if (landed.kind === 'unread') {
    return refused(
      'merged-without-evidence',
      `\`${read.baseRef}\` already holds ${named}'s head, so it is merged, but its landing cannot be named: ${landed.why}. Do not merge it again.`,
    );
  }
  return {
    kind: 'already-merged',
    commitSha: landed.commitSha,
    mergedAt: landed.mergedAt,
    target: landed.target,
    head: landed.head,
  };
}
