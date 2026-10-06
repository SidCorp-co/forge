import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "@/design";
import { feedbackHref } from "@/lib/routes/feedback";
import type { FeedbackPhase } from "../types";

export function FeedbackRailItem({
  slug,
  itemKey,
  title,
  phase,
  hint,
  children,
}: {
  slug: string;
  itemKey: string;
  title: string;
  phase: FeedbackPhase;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <li className="grid min-w-0 gap-0.5 text-13" data-testid="rail-feedback">
      <span className="flex min-w-0 items-center gap-1.5">
        <Link href={feedbackHref(slug, itemKey)} className="flex-none font-mono text-12 font-semibold text-link hover:underline">
          {itemKey}
        </Link>
        <span className="min-w-0 flex-1 truncate" title={hint ?? title}>
          {title}
        </span>
        <StatusBadge family="feedbackPhase" value={phase} />
      </span>
      {children}
    </li>
  );
}
