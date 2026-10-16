import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import type { ApprovalItem } from "./types";

export const approvalsHref = (slug: string) => `/projects/${encodeURIComponent(slug)}/approvals`;

/** The page a row opens on, or null where it opens none. */
export function approvalOpensHref(slug: string, opens: ApprovalItem["opens"]): string | null {
  if (!opens) return null;
  switch (opens.kind) {
    case "issue":
      return issueHref(slug, opens.key);
    case "requirement":
      return requirementHref(slug, opens.key);
    case "feedback":
      return feedbackHref(slug, opens.key);
    case "workflow":
      return workflowHref(slug, opens.key);
    case "release":
      return releaseHref(slug, opens.key);
  }
}
