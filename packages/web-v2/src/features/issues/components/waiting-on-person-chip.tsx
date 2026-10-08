"use client";

import { workStateOf } from "@forge/contracts/work-state";
import { MonoTag } from "@/design";
import { formatElapsed } from "@/lib/utils/format";
import type { IssueStatus } from "../types";

/** A question on a draft, finished work or the release gate leaves its state alone, so the row says nothing there. */
export function WaitingOnPersonChip({
  since,
  status,
  now,
}: {
  since: string | null | undefined;
  status: IssueStatus;
  now: number;
}) {
  if (!since) return null;
  if (workStateOf(status, true) !== "blocked_on_person") return null;
  const at = new Date(since).getTime();
  if (Number.isNaN(at)) return null;
  const age = formatElapsed(now - at);
  return (
    <span
      title={`A question on this issue has waited on a person for ${age}. Answer it on the issue.`}
      data-testid="waiting-on-person"
    >
      <MonoTag hue="flame">Waiting on a person · {age}</MonoTag>
    </span>
  );
}
