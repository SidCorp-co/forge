"use client";

import type { IssueProgress } from "@forge/contracts/forecast";
import { useCopy } from "@/lib/i18n/interface-language";
import { progressText } from "../progress";

/** A scope's progress in the one vocabulary. */
export function IssueProgressText({ progress, className }: { progress: IssueProgress; className?: string }) {
  const t = useCopy();
  return (
    <span className={className} data-testid="issue-progress">
      {progressText(progress, t)}
    </span>
  );
}
