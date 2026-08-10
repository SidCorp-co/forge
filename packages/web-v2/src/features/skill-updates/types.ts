// web-v2 feature module: skill updates (Update Pipeline stage ② review surface).
//
// Mirrors `ReconcileRun` in packages/core/src/db/schema.ts. Only the fields this
// screen renders are typed; the bundle snapshot is deliberately left opaque —
// the reviewer's decision rests on the diff, the rationale and the votes.

export type ReconcileVerdict = "no-op" | "apply" | "apply-with-adaptation" | "escalate";
export type ReconcileGate = "auto" | "human";
export type ReconcileRunStatus =
  | "pending"
  | "running"
  | "verifying"
  | "decided"
  | "applied"
  | "escalated"
  | "failed";

export interface VerifierVote {
  jobId: string;
  vote: "pass" | "fail";
  reason: string;
}

export interface ReconcileRunSummary {
  id: string;
  projectId: string;
  packetId: string | null;
  skillId: string | null;
  status: ReconcileRunStatus;
  verdict: ReconcileVerdict | null;
  gate: ReconcileGate | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ReconcileRunDetail extends ReconcileRunSummary {
  rationale: string | null;
  refusalReason: string | null;
  error: string | null;
  candidateBody: string | null;
  lastGoodBody: string | null;
  verifierVotes: VerifierVote[] | null;
  bundle: { change?: string; story?: string; intentClass?: string; appliesTo?: string } | null;
}

/** One line of a side-by-side body comparison. */
export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}
