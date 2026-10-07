"use client";

import type { IssueProgress } from "@forge/contracts/forecast";
import { useCopy } from "@/lib/i18n/interface-language";
import { progressText } from "../progress";

/** A scope's progress in the one vocabulary, what each word means on hover. */
export function IssueProgressText({ progress, className }: { progress: IssueProgress; className?: string }) {
  const t = useCopy();
  return (
    <span className={className} title={t("progress.hint")} data-testid="issue-progress">
      {progressText(progress, t)}
    </span>
  );
}
