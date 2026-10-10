// The two times a requirement's standing carries: when it came to stand in its state (what the
// list's AGE reads) and its newest write (what the sort and stuck read). Only a status move or an
// issue's work moves the first; any write moves the second.
import type { RequirementState } from '@forge/contracts/requirements';
import type { StandingInput, StandingIssue } from './standing.js';

/**
 * When it came to stand in `state` (REQ-29 BC-5's age): its last status move, and inside agreed the
 * delivery phase's own start, the first live issue's work for in delivery and the last close for
 * delivered. No edit that moves neither a status nor an issue (an area, a short name) restarts it.
 */
export function stateSinceOf(
  input: StandingInput,
  state: RequirementState,
  live: readonly StandingIssue[],
): Date {
  const status = input.statusSince;
  const at = (dates: (Date | null | undefined)[], pick: (ms: number[]) => number) => {
    const ms = dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
    return ms.length ? pick(ms) : null;
  };
  const phase =
    state === 'in_delivery'
      ? at(
          live.map((i) => i.startedAt),
          (ms) => Math.min(...ms),
        )
      : state === 'delivered'
        ? at(
            live.map((i) => i.closedAt),
            (ms) => Math.max(...ms),
          )
        : null;
  return new Date(Math.max(status.getTime(), phase ?? 0));
}

/** The newest write to the requirement, its revisions or its issues. */
export function touchedAt(input: StandingInput): Date {
  const times = [
    input.updatedAt,
    ...input.revisions.flatMap((r) => [r.createdAt, r.proposedAt, r.decidedAt]),
    ...input.issues.map((i) => i.updatedAt),
  ].filter((t): t is Date => t !== null);
  return new Date(Math.max(...times.map((t) => t.getTime())));
}
