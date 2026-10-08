"use client";

import Link from "next/link";
import type { CommentTargetView } from "@forge/contracts/comments";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";

/** Where a decision's target lives on the site. */
export function decisionTargetHref(slug: string, target: Pick<CommentTargetView, "scope" | "key">): string {
  if (target.scope === "issue") return issueHref(slug, target.key);
  if (target.scope === "requirement") return requirementHref(slug, target.key);
  if (target.scope === "workflow") return workflowHref(slug, target.key);
  return feedbackHref(slug, target.key);
}

/** The key of what a decision sits on, as a link; its title rides the tooltip. */
export function DecisionTarget({ slug, target }: { slug: string; target: CommentTargetView }) {
  return (
    <Link href={decisionTargetHref(slug, target)} className="font-mono text-12 font-semibold text-link hover:underline" title={target.title ?? undefined} data-testid="decision-target">
      {target.key}
    </Link>
  );
}
