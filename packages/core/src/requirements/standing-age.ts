// The two times a requirement's standing carries: when it came to stand in its state (what the
// list's AGE reads) and its newest write (what the sort and stuck read). Only a status move moves the
// first; any write moves the second.
import type { StandingInput } from './standing.js';

/**
 * When it came to stand in its state (REQ-29 BC-5's age): its last status move, every step being a
 * stored status moved by an act. No edit that moves no status (an area, a short name) restarts it.
 */
export function stateSinceOf(input: Pick<StandingInput, 'statusSince'>): Date {
  return input.statusSince;
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
