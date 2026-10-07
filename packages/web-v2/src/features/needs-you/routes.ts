import { questionHref } from "@/lib/routes/agents";
import { reportHref, scheduleHref } from "@/lib/routes/automation";
import { contractHref } from "@/lib/routes/contracts";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref, issuesHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import type { NeedsYouItem } from "./types";

/** The page a needs-you row opens, by what it is. */
export function needsYouHref(slug: string, n: Pick<NeedsYouItem, "entity" | "key"> & { waitingOn?: Pick<NeedsYouItem["waitingOn"], "kind"> }): string {
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
    case "question":
      return questionHref(slug, n.key);
    case "workflow":
      // core words a revision waiting on the viewer as `you`, and a health marker owed as a person: the first is decided on the revisions tab
      return n.waitingOn?.kind === "you" ? `${workflowHref(slug, n.key)}?tab=revisions` : workflowHref(slug, n.key);
  }
}

/** An issue opens in the list's peek; everything else opens its page. */
export const needsYouPeekHref = (slug: string, n: Parameters<typeof needsYouHref>[1]): string =>
  n.entity === "issue" ? `${issuesHref(slug)}?peek=${encodeURIComponent(n.key)}` : needsYouHref(slug, n);
