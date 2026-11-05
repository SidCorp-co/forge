import type { ReleaseVerified } from "@forge/contracts/releases";

// A release's one proof number (ISS-1001): its criteria proven of their total, on the environment
// they are judged on, as core's release record counts them (`release-read-views.ts:summaryOf`), the
// count the list row and the page header both carry. The list and the page draw it from here and
// from nothing else, so one release never says two numbers.

export interface ReleaseProof {
  proven: number;
  total: number;
  /** The environment the criteria were judged on; null where a commit verdict proves them. */
  on: string | null;
}

/** Null where the release carries no criteria: nothing was judged, so no bar is drawn. */
export function releaseProofOf(v: Pick<ReleaseVerified, "proven" | "total" | "judgedOn">): ReleaseProof | null {
  if (v.total === 0) return null;
  return { proven: v.proven, total: v.total, on: v.judgedOn ?? null };
}

export const unprovenOf = (p: ReleaseProof | null): number => (p ? p.total - p.proven : 0);
