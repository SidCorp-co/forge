import { jobKindLabel, unrecognised } from "@/features/overview/job-kinds";
import { FAILURE_REASON_LABEL, type SessionFailureReason } from "@/features/sessions/types";
import type { AttentionItem } from "./types";

/** A stored code is one lower-case token; anything else a job wrote is a sentence of its own. */
const STORED_CODE = /^[a-z][a-z0-9_-]*$/;

/** A failure in the words the overview uses for it: a known cause by its label, an unknown code as unknown. */
export function failureWords(failure: string | null | undefined): string | null {
  const said = failure?.trim();
  if (!said) return null;
  const label = FAILURE_REASON_LABEL[said as SessionFailureReason];
  if (label) return label;
  return STORED_CODE.test(said) ? unrecognised("failure", said) : said.slice(0, 80);
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
