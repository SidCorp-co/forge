// A merge call whose outcome the host never confirmed: it threw (a timeout, a relay that dropped
// the answer) or refused in words that leave the merge itself unknown. adminhub-fe !1994,
// 2026-10-26: GitLab merged it at 8ab74c9f through the relay, the relay's answer timed out, and
// `merge-pull-request` answered 500, which a caller reads as "retry" and so as "merge again".
// Core asks the host what the request is now and answers from that: merged is the landing it
// observed, anything else is a named refusal. Nothing here sends a second merge.

import type { HostMergeResult, SourceHost } from './types.js';

/** Refusals sent after the merge may have reached the host, so the request is read back. */
const UNCONFIRMED_REASONS: ReadonlySet<string> = new Set([
  'host-error',
  'merge-not-confirmed',
  'timed-out-mid-write',
  'unknown',
]);

/** Whether a refusal leaves the merge's outcome unknown, so the request is read back first. */
export function outcomeUnconfirmed(result: HostMergeResult): boolean {
  return result.kind === 'refused' && UNCONFIRMED_REASONS.has(result.reason);
}

/** The landing a re-read observed, kept apart from a merge the host confirmed itself. */
export type ObservedMerge = Extract<HostMergeResult, { kind: 'merged' | 'already-merged' }> & {
  /** What the merge call hit before the request was read merged. */
  observedAfter: string;
};

/**
 * The request read back after a merge whose outcome is unknown: the landing it shows, or a named
 * refusal saying whether it is unmerged (sending the merge again is safe) or unreadable (it is not).
 */
export async function readBackMerge(
  host: SourceHost,
  number: number,
  failure: string,
  refused: Extract<HostMergeResult, { kind: 'refused' }> | null,
): Promise<ObservedMerge | Extract<HostMergeResult, { kind: 'refused' }>> {
  const named = `${host.words.changeRequest} ${host.words.sigil}${number}`;
  let read: Awaited<ReturnType<SourceHost['readChangeRequest']>>;
  try {
    read = await host.readChangeRequest(number);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      kind: 'refused',
      reason: 'merge-outcome-unknown',
      detail: `${host.provider} did not confirm the merge of ${named} (${failure}), and reading it back failed too (${why}), so whether it merged is unknown. Do not send the merge again: read ${named} on ${host.provider}; if it merged, its merged event records the landing, and another call to this verb answers it as merged without merging again.`,
    };
  }
  const mergedAt = read.mergedAt ? new Date(read.mergedAt) : null;
  if (
    read.state === 'merged' &&
    read.mergeCommitSha &&
    mergedAt &&
    !Number.isNaN(mergedAt.getTime()) &&
    read.baseRef
  ) {
    return {
      kind: 'merged',
      commitSha: read.mergeCommitSha.toLowerCase(),
      mergedAt,
      target: read.baseRef,
      head: read.headSha,
      observedAfter: failure,
    };
  }
  if (read.state === 'merged') {
    return {
      kind: 'refused',
      reason: 'merged-without-evidence',
      detail: `${host.provider} did not confirm the merge of ${named} (${failure}); read back, it is merged, but ${host.provider} named no merge commit, merge time or base branch, so there is no landing to record. Do not send the merge again: its merged event records the landing.`,
    };
  }
  const now = `Forge read ${named} back and it is \`${read.state}\`, not merged, so nothing landed`;
  if (refused) return { ...refused, detail: `${refused.detail} ${now}.` };
  return {
    kind: 'refused',
    reason: 'merge-unconfirmed',
    detail: `${host.provider} did not answer the merge of ${named} (${failure}). ${now}; sending the merge again is safe.`,
  };
}
