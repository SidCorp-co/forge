// The decisions a turn read with `forge_needs_you` (REQ-41 BC-2), drawn under its reply from the
// tool's own result: the model names no button, so none can be invented, and each one posts to the
// route the record's page calls, as the person who presses it. A decision the same turn made with
// `act_on_decisions` on the person's word is not drawn again (BC-25), and a press is answered in the
// room with the item read back, so "Sent" is never the last word (BC-24).

import { CHAT_DECIDE_TOOL, type DecisionOutcomeRequest, readChatDecideResult } from "@forge/contracts/chat-decide";
import { type NeedsYouDecisions, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { type DecisionSettled, DecisionList } from "@/features/needs-you";
import type { CanonicalBlock } from "@/features/session";
import { useMutation } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { toolOutputText } from "@/lib/tool-output";
import { conversationsApi } from "./api";

/** The assistant's read of the decisions waiting on the asker, the one the needs-you route answers. */
const NEEDS_YOU_TOOL = "forge_needs_you";

/** What the turn's `act_on_decisions` calls made or found made: decision ids, and the keys of items already moved. */
function madeIn(blocks: readonly CanonicalBlock[]): { ids: Set<string>; keys: Set<string> } {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const b of blocks) {
    if (b.type !== "tool" || b.toolCall?.name !== CHAT_DECIDE_TOOL || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    for (const r of readChatDecideResult(toolOutputText(b.toolCall.output))?.results ?? []) {
      if (r.outcome === "done") ids.add(r.id);
      // an item made or found moved is no longer waiting, whichever decision on it was drawn
      if (r.outcome !== "refused" && r.state) keys.add(r.state.key.toUpperCase());
    }
  }
  return { ids, keys };
}

/** The decisions a turn's newest `forge_needs_you` call returned, less any the turn made since; null where none did. */
export function decisionsIn(blocks: readonly CanonicalBlock[] | null | undefined): NeedsYouDecisions | null {
  let found: NeedsYouDecisions | null = null;
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || b.toolCall?.name !== NEEDS_YOU_TOOL || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    try {
      const parsed = needsYouDecisionsSchema.safeParse(JSON.parse(toolOutputText(b.toolCall.output)));
      if (parsed.success) found = parsed.data;
    } catch {
      // a result that is not the read's JSON draws nothing
    }
  }
  if (!found) return null;
  const made = madeIn(blocks ?? []);
  const left = found.decisions.filter(
    (d) => !made.ids.has(d.id) && !made.keys.has((d.opens?.key ?? d.key).toUpperCase()),
  );
  return { ...found, decisions: left, total: found.total - (found.decisions.length - left.length) };
}

/** The follow-up a settled press asks core for: the decision, the item it opens, and whether it went through. */
export function outcomeOf({ decision, ok }: DecisionSettled): DecisionOutcomeRequest {
  const opens = decision.opens;
  const item =
    opens && (opens.kind === "issue" || opens.kind === "requirement" || opens.kind === "feedback")
      ? { kind: opens.kind, key: opens.key }
      : null;
  return { decision: decision.id, opens: item, ok };
}

/** The list, its presses answered in `conversationId`'s room. */
function AnsweredList({ read, slug, conversationId }: { read: NeedsYouDecisions; slug: string | undefined; conversationId: string }) {
  const t = useCopy();
  const follow = useMutation({
    mutationFn: (settled: DecisionSettled) => conversationsApi.decisionOutcome(conversationId, outcomeOf(settled)),
  });
  return (
    <>
      <DecisionList read={read} slug={slug} onSettled={(s) => follow.mutate(s)} />
      {follow.isError && (
        <p className="fg-caption text-danger" role="alert" data-testid="decision-follow-up-failed">
          {t("conversations.decisions.followUpFailed", { error: formatApiError(follow.error) })}
        </p>
      )}
    </>
  );
}

/** The list under the turn that read it; nothing where the turn read none. */
export function TurnDecisions({
  blocks,
  slug,
  conversationId,
}: {
  blocks: readonly CanonicalBlock[] | null | undefined;
  slug?: string | undefined;
  conversationId?: string | undefined;
}) {
  const read = decisionsIn(blocks);
  if (!read) return null;
  return (
    <div className="mt-2">
      {conversationId ? <AnsweredList read={read} slug={slug} conversationId={conversationId} /> : <DecisionList read={read} slug={slug} />}
    </div>
  );
}
