import { scheduleHref } from "@/lib/routes/automation";
import { contractHref } from "@/lib/routes/contracts";
import { feedbackHref } from "@/lib/routes/feedback";
import { questionDecisionHref } from "@/lib/routes/approvals";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import type { DecisionOpens } from "@forge/contracts/needs-you-decisions";
import type { NeedsYouItem } from "./types";

/** The page a needs-you row opens, by what it is. */
export function needsYouHref(slug: string, n: Pick<NeedsYouItem, "entity" | "key"> & { waitingOn?: Pick<NeedsYouItem["waitingOn"], "kind"> }): string {
  switch (n.entity) {
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
    case "question":
      return questionDecisionHref(slug, n.key);
    case "workflow":
      // core words a revision waiting on the viewer as `you`, and a health marker owed as a person: the first is decided on the revisions tab
      return n.waitingOn?.kind === "you" ? `${workflowHref(slug, n.key)}?tab=revisions` : workflowHref(slug, n.key);
  }
}

/** The page a decision opens on, or null where no record holds it. */
export function decisionHref(slug: string, opens: DecisionOpens | null): string | null {
  if (!opens) return null;
  switch (opens.kind) {
    case "requirement":
      return requirementHref(slug, opens.key);
    case "feedback":
      return feedbackHref(slug, opens.key);
    case "workflow":
      return workflowHref(slug, opens.key);
    case "release":
      return releaseHref(slug, opens.key);
    case "contract":
      return contractHref(slug, opens.key);
  }
}

/** What a row is called in a list: its key, or for a schedule or a question (keyed by an id no reader knows) the area it sits in. */
export const needsYouKeyLabel = (n: Pick<NeedsYouItem, "entity" | "key" | "area">, areaLabel: (area: string) => string): string =>
  n.entity === "schedule" || n.entity === "question" ? areaLabel(n.area) : n.key;
