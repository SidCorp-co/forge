"use client";

import { MonoTag } from "@/design";
import { formatElapsed } from "@/lib/utils/format";

/** ISS-1257 — the issue list is the queue of what a person owes an answer to, so the row says so. */
export function WaitingOnPersonChip({
  since,
  now,
}: {
  since: string | null | undefined;
  /** The list's one instant, so two rows' ages are a comparison. */
  now: number;
}) {
  if (!since) return null;
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
