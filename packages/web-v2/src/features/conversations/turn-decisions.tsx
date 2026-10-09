"use client";

// The decisions a turn read with `forge_needs_you` (REQ-41 BC-2), drawn under its reply from the
// tool's own result: the model names no button, so none can be invented, and each one posts to the
// route the record's page calls, as the person who presses it.

import { type NeedsYouDecisions, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { DecisionList } from "@/features/needs-you/components/decision-list";
import type { CanonicalBlock } from "@/features/session/types";
import { textOf } from "./ui-actions/actions";

/** The assistant's read of the decisions waiting on the asker, the one the needs-you route answers. */
export const NEEDS_YOU_TOOL = "forge_needs_you";

/** The decisions a turn's newest `forge_needs_you` call returned, or null where none did. */
export function decisionsIn(blocks: readonly CanonicalBlock[] | null | undefined): NeedsYouDecisions | null {
  let found: NeedsYouDecisions | null = null;
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || b.toolCall?.name !== NEEDS_YOU_TOOL || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    try {
      const parsed = needsYouDecisionsSchema.safeParse(JSON.parse(textOf(b.toolCall.output)));
      if (parsed.success) found = parsed.data;
    } catch {
      // a result that is not the read's JSON draws nothing
    }
  }
  return found;
}

/** The list under the turn that read it; nothing where the turn read none. */
export function TurnDecisions({ blocks, slug }: { blocks: readonly CanonicalBlock[] | null | undefined; slug?: string | undefined }) {
  const read = decisionsIn(blocks);
  if (!read) return null;
  return (
    <div className="mt-2">
      <DecisionList read={read} slug={slug} />
    </div>
  );
}
