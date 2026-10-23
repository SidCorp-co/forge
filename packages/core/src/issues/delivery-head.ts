// REQ-63 BC-6: on a project that releases by merging its change requests, an issue's head is the
// head of the open change request linked to it (`release-batch/landed-build.ts:deliveryHeadsOf`),
// never a run's worklog capture of its work branch. Every read that hands out the issue's branch and
// head goes through here: the detail and list work state, and the standing.

import { deliveryHeadsOf } from './ports.js';

type Head = { branch: string | null; headSha: string | null };
export type DeliveryHeads = Map<
  string,
  { sha: string | null; branch: string | null; basis: string }
>;

/** Each issue's head on a change-request project; null on any other, which reads the work state. */
export async function deliveryHeads(
  projectId: string,
  issueIds: readonly string[],
): Promise<DeliveryHeads | null> {
  if (issueIds.length === 0) return null;
  return deliveryHeadsOf(projectId, issueIds);
}

/**
 * The work state with the issue's head in `branch` and `headSha`, the run's own capture kept beside
 * them as `captured` and how the head was read as `headBasis`, so neither is mistaken for the other.
 */
export function withDeliveryHead<W extends Head>(
  issueId: string,
  workState: W | null,
  heads: DeliveryHeads | null,
): (W & { captured?: Head; headBasis?: string }) | null {
  const head = heads?.get(issueId.toLowerCase());
  if (!head || !workState) return workState;
  return {
    ...workState,
    branch: head.branch,
    headSha: head.sha,
    captured: { branch: workState.branch, headSha: workState.headSha },
    headBasis: head.basis,
  };
}
