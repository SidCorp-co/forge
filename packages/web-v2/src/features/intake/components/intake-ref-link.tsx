// One record an intake draft or its value check names, linked to its page.

import { Link } from "@/lib/navigation/router";
import { feedbackHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import type { IntakeDraftRef } from "../types";

function hrefOf(slug: string, ref: Pick<IntakeDraftRef, "kind" | "key">): string {
  if (ref.kind === "requirement") return requirementHref(slug, ref.key);
  if (ref.kind === "feedback") return feedbackHref(slug, ref.key);
  if (ref.kind === "workflow") return workflowHref(slug, ref.key);
  return releaseHref(slug, ref.key);
}

export function IntakeRefLink({ slug, target: r }: { slug: string; target: Pick<IntakeDraftRef, "kind" | "key"> }) {
  return (
    <Link href={hrefOf(slug, r)} className="font-mono text-13 text-accent-text hover:underline" data-testid="intake-ref">
      {r.key}
    </Link>
  );
}
