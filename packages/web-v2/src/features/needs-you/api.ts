import type { DecisionAnswer, NeedsYouDecisions } from "@forge/contracts/needs-you-decisions";
import { apiClient } from "@/lib/api/client";
import type { NeedsYouResponse } from "./types";

/** A decision's filled path is a core route (`/api/...`); the client adds that prefix itself. */
const endpointOf = (path: string) => (path.startsWith("/api/") ? path.slice("/api".length) : path);

export const needsYouApi = {
  read: (projectId: string) => apiClient<NeedsYouResponse>(`/projects/${projectId}/needs-you`),
  decisions: (projectId: string) => apiClient<NeedsYouDecisions>(`/projects/${projectId}/needs-you/decisions`),
  /** Press one decision's button: its body to its filled path, as the signed-in person. */
  press: (path: string, body: Record<string, unknown>) =>
    apiClient<unknown>(endpointOf(path), { method: "POST", body: JSON.stringify(body) }),
};

/**
 * The body a button posts: its own, and what the person typed under the field its route reads: for a
 * question, the answer's `text`, or the `note` an option carries (a steward decision's reason); the
 * `reason` for every other act that takes one.
 */
export function pressBody(answer: DecisionAnswer, typed: string | null): Record<string, unknown> {
  const body = { ...(answer.body ?? {}) };
  if (!answer.needsReason) return body;
  const field = answer.act !== "question.answer" ? "reason" : "optionId" in body ? "note" : "text";
  body[field] = typed ?? "";
  return body;
}

/**
 * The words an answer that asks them starts from: the recommendation's why core put in its body
 * (REQ-68 BC-2), under the field `pressBody` writes, else nothing.
 */
export function prefillOf(answer: DecisionAnswer): string {
  const body = answer.body ?? {};
  const words = answer.act !== "question.answer" ? body.reason : "optionId" in body ? body.note : undefined;
  return typeof words === "string" ? words : "";
}

/**
 * The words a press sends without asking (REQ-68 BC-2, one click): the recommended answer's own,
 * which core prefilled from the recommendation's why. Null where the person is asked for them: an
 * answer that is not the recommended one, or one core gave no words to.
 */
export function wordsAsItStands(answer: DecisionAnswer): string | null {
  if (!answer.needsReason || !answer.recommended) return null;
  const words = prefillOf(answer).trim();
  return words ? words : null;
}
