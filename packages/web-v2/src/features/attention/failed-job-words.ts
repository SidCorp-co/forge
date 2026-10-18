import { jobKindLabel, unrecognised } from "@/features/overview/job-kinds";
import { FAILURE_REASON_LABEL, type SessionFailureReason } from "@/features/sessions/types";
import { resolveFailureCause } from "@forge/contracts/failure-causes";
import type { AttentionItem } from "./types";

/** A stored code is one lower-case token; anything else a job wrote is a sentence of its own. */
const STORED_CODE = /^[a-z][a-z0-9_-]*$/;

/** A cause code in the overview's words; a sentence is a job's diagnostic and says nothing (ISS-1229 r15). */
export function failureWords(failure: string | null | undefined): string | null {
  const said = failure?.trim();
  if (!said || !STORED_CODE.test(said)) return null;
  const label = FAILURE_REASON_LABEL[said as SessionFailureReason];
  if (label) return label;
  const cause = resolveFailureCause(said);
  return cause === "unclassified" ? unrecognised("failure", said) : FAILURE_REASON_LABEL[cause];
}

/** A failed job's row in words, as in "Issue work failed: Session lost", never stored codes (ISS-1229 r14). */
export function failedJobWords(item: Pick<AttentionItem, "jobType" | "failure">): string {
  if (item.jobType === undefined) {
    throw new Error(
      "A failed job on Attention carries no `jobType`, so its kind of work cannot be said. The server is not the release this page was built for.",
    );
  }
  const why = failureWords(item.failure);
  const work = jobKindLabel(item.jobType);
  return why ? `${work} failed: ${why}` : `${work} failed`;
}

/** A failed job said under the row an answer owed heads, as in "A job on it failed: Session lost." */
export function failedJobClause(job: { failure: string | null }): string {
  const why = failureWords(job.failure);
  return why ? `A job on it failed: ${why}.` : "A job on it failed.";
}
