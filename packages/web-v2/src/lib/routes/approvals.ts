import { questionDecisionId } from "@forge/contracts/needs-you-decisions";

/** The project's Approvals page, the full Needs you list the Dashboard's "+n more" links to (REQ-48 BC-11). */
export const approvalsHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/approvals`;

/** Approvals with one question's decision open in the peek: where a question waiting on a person is answered (REQ-68 BC-9). */
export const questionDecisionHref = (slug: string, questionId: string) =>
  `${approvalsHref(slug)}?peek=${encodeURIComponent(questionDecisionId(questionId))}`;
