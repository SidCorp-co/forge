// The decisions a turn read with `forge_needs_you` (REQ-41 BC-2), drawn under its reply from the
// tool's own result: the model names no button, so none can be invented, and each one posts to the
// route the record's page calls, as the person who presses it. A decision the same turn made with
// `act_on_decisions` on the person's word is not drawn again (BC-25), and a press is answered in the
// room with the item read back, so "Sent" is never the last word (BC-24). What that act made is drawn
// from its own result, one row per item with the state read back, so no item it made or refused goes
// unreported whatever the reply says (ISS-624, judge K66: reporting each was left to the model).

import {
  CHAT_DECIDE_TOOL,
  type ChatDecisionResult,
  DECISION_OUTCOME_LIMITS,
  type DecisionOutcomeRequest,
  type DecisionPressFailure,
  readChatDecideResult,
} from "@forge/contracts/chat-decide";
import { type NeedsYouDecisions, needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { type DecisionSettled, DecisionList } from "@/features/needs-you";
import type { CanonicalBlock } from "@/features/session";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { toolOutputText } from "@/lib/tool-output";
import { conversationsApi } from "./api";

/** The assistant's read of the decisions waiting on the asker, the one the needs-you route answers. */
const NEEDS_YOU_TOOL = "forge_needs_you";

/** Every item the turn's `act_on_decisions` calls read back, in the order they were acted on. */
export function actResultsIn(blocks: readonly CanonicalBlock[] | null | undefined): ChatDecisionResult[] {
  const out: ChatDecisionResult[] = [];
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || b.toolCall?.name !== CHAT_DECIDE_TOOL || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    out.push(...(readChatDecideResult(toolOutputText(b.toolCall.output))?.results ?? []));
  }
  return out;
}

/** What the turn's `act_on_decisions` calls made or found made: decision ids, and the keys of items already moved. */
function madeIn(blocks: readonly CanonicalBlock[]): { ids: Set<string>; keys: Set<string> } {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const r of actResultsIn(blocks)) {
    if (r.outcome === "done") ids.add(r.id);
    // an item made or found moved is no longer waiting, whichever decision on it was drawn
    if (r.outcome !== "refused" && r.state) keys.add(r.state.key.toUpperCase());
  }
  return { ids, keys };
}

/** One row per item the turn's act read back: its key and state, or that it was not made and why on hover. */
function ActResults({ results }: { results: readonly ChatDecisionResult[] }) {
  const t = useCopy();
  return (
    <ul className="fg-body-sm flex flex-col gap-0.5" data-testid="decision-act-results">
      {results.map((r) => {
        const key = r.state?.key ?? r.decision;
        const said =
          r.outcome === "refused"
            ? t("conversations.decisions.actRefused", { key })
            : t(r.outcome === "done" ? "conversations.decisions.actDone" : "conversations.decisions.actAlready", {
                key,
                status: r.state?.status ?? "",
              });
        return (
          <li
            key={`${r.decision}:${r.outcome}`}
            data-outcome={r.outcome}
            // why it was refused and, for a Product act, what the person can do next (REQ-69 BC-5), on hover
            title={r.outcome === "refused" ? [r.detail, r.next].filter(Boolean).join(" ") : undefined}
          >
            {said}
          </li>
        );
      })}
    </ul>
  );
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

/** Why a press failed, as core refused it: its code and sentence, or the transport's where none came back. */
export function pressFailureOf(error: unknown): DecisionPressFailure {
  const code =
    error instanceof ApiError
      ? error.code && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
        ? error.code
        : `HTTP_${error.status}`
      : "NETWORK";
  const said = error instanceof Error && error.message.trim() ? error.message.trim() : "no reason came back with it";
  return { code, detail: said.slice(0, DECISION_OUTCOME_LIMITS.detail) };
}

/** The follow-up a settled press asks core for: the decision, its row, the item it opens, and whether it went through and why not. */
export function outcomeOf(settled: DecisionSettled): DecisionOutcomeRequest {
  const { decision } = settled;
  const opens = decision.opens;
  const item =
    opens && (opens.kind === "requirement" || opens.kind === "feedback")
      ? { kind: opens.kind, key: opens.key }
      : null;
  const pressed = { decision: decision.id, key: decision.key, opens: item };
  return settled.ok ? { ...pressed, ok: true } : { ...pressed, ok: false, failure: pressFailureOf(settled.error) };
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
  const acted = actResultsIn(blocks);
  if (!read && acted.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {acted.length > 0 && <ActResults results={acted} />}
      {read &&
        (conversationId ? <AnsweredList read={read} slug={slug} conversationId={conversationId} /> : <DecisionList read={read} slug={slug} />)}
    </div>
  );
}
