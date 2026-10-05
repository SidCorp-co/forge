import { reportHref, scheduleHref } from "@/features/automation/routes";
import { contractHref } from "@/features/contracts/routes";
import { feedbackHref } from "@/features/feedback/routes";
import { issueHref, issuesHref } from "@/features/issues/routes";
import { releaseHref } from "@/features/releases/routes";
import { requirementHref } from "@/features/requirements/routes";
import { workflowHref } from "@/features/workflows/routes";
import type { NeedsYouItem } from "./types";

/** The page a needs-you row opens, by what it is. */
export function needsYouHref(slug: string, n: Pick<NeedsYouItem, "entity" | "key">): string {
  switch (n.entity) {
    case "issue":
      return issueHref(slug, n.key);
    case "requirement":
      return requirementHref(slug, n.key);
    case "release":
      return releaseHref(slug, n.key);
    case "feedback":
      return feedbackHref(slug, n.key);
    case "contract":
      return contractHref(slug, n.key);
    case "schedule":
      return scheduleHref(slug, n.key);
    case "report":
      return reportHref(slug, n.key);
    case "workflow":
      return workflowHref(slug, n.key);
  }
}

/** An issue opens in the list's peek; everything else opens its page. */
export const needsYouPeekHref = (slug: string, n: Pick<NeedsYouItem, "entity" | "key">): string =>
  n.entity === "issue" ? `${issuesHref(slug)}?peek=${encodeURIComponent(n.key)}` : needsYouHref(slug, n);
