import { ISSUE_KEY_REFUSAL_CODES, type IssueKeyRefusalCode } from "@forge/contracts/issue-vocabulary";
import { REGISTRY_ISSUE_STATUSES } from "@forge/contracts/pipeline-registry";
import { WORK_STATES, type WorkState } from "@forge/contracts/work-state";
import { ApiError } from "@/lib/api/client";
import type { IssueBuckets } from "./api";

/** The search's refusal of a key it cannot answer, which a Retry would only resend (ISS-1334). */
export function issueKeyRefusalOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code === undefined) return null;
  return (ISSUE_KEY_REFUSAL_CODES as readonly string[]).includes(error.code as IssueKeyRefusalCode)
    ? error.message
    : null;
}

/** What a refused key counts: the server said no issue here answers the term, at any status. */
export const NO_ISSUE_BUCKETS: IssueBuckets = {
  byStatus: Object.fromEntries(REGISTRY_ISSUE_STATUSES.map((s) => [s, 0])),
  byWorkState: Object.fromEntries(WORK_STATES.map((s) => [s, 0])) as Record<WorkState, number>,
};
