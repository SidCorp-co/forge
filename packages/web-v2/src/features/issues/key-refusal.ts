import { ISSUE_KEY_REFUSAL_CODES, type IssueKeyRefusalCode } from "@forge/contracts/issue-vocabulary";
import { ApiError } from "@/lib/api/client";

/** The search's refusal of a key it cannot answer, which a Retry would only resend (ISS-1334). */
export function issueKeyRefusalOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code === undefined) return null;
  return (ISSUE_KEY_REFUSAL_CODES as readonly string[]).includes(error.code as IssueKeyRefusalCode)
    ? error.message
    : null;
}
