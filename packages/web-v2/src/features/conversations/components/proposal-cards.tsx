
// A write a chat turn proposed waits here, above the composer, until the person it answers agrees
// (REQ-30 BC-4, workflow chat-turn step confirm), for that person alone Record it / Decline. Everyone
// else in the room reads whom it waits on. Once it is decided, core says so in the thread, and the card
// goes.
//
// The person decides from one plain line the proposing agent wrote (ISS-1006, owner 2026-11-05); where
// it wrote none, the card says so in its place. The WHOLE proposal (ISS-439: a person agrees only to
// what they could read) is one press away behind the closed "Technical" fold: every line core
// summarised from the held call, none clipped, scrolling inside the fold. A card folds down to its one
// line, and the cards together never take more than part of the room, so the chat stays readable.

import type { ChatProposalView } from "@forge/contracts/chat-proposals";
import { useState } from "react";
import { Button, Disclosure, IconButton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useConversationProposals, useDecideProposal } from "../hooks";

/** Each line with a key of its own: a line written twice is shown twice, as the proposal holds it. */
function keyedLines(lines: readonly string[]): { key: string; line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    return { key: `${n}:${line}`, line };
  });
}

export function ProposalCards({
  conversationId,
  threadLength,
}: {
  conversationId: string | undefined;
  threadLength: number;
}) {
  const t = useCopy();
  const listed = useConversationProposals(conversationId, threadLength);
  const decide = useDecideProposal(conversationId);
  const pending = (listed.data ?? []).filter((p) => p.status === "pending");
  if (pending.length === 0) return null;
  return (
    <section
      aria-label={t("conversations.proposal.heading")}
      data-testid="proposal-cards"
      className="flex max-h-1/2 flex-none flex-col gap-2 overflow-y-auto border-t border-line bg-surface px-4 py-3"
    >
      {pending.map((p) => (
        <HeldProposal
          key={p.id}
          proposal={p}
          deciding={decide.isPending && decide.variables?.proposalId === p.id}
          onDecide={(decision) => decide.mutate({ proposalId: p.id, decision })}
        />
      ))}
      {decide.isError && (
        <p className="fg-caption text-danger" role="alert">
          {formatApiError(decide.error)}
        </p>
      )}
    </section>
  );
}

function HeldProposal({
  proposal,
  deciding,
  onDecide,
}: {
  proposal: ChatProposalView;
  deciding: boolean;
  onDecide: (decision: "agree" | "decline") => void;
}) {
  const t = useCopy();
  const { summary } = proposal;
  const [folded, setFolded] = useState(false);
  const plain = summary.plain ?? null;
  return (
    <div data-testid="proposal-card" data-kind={proposal.kind} data-folded={folded} className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
      <div className="flex min-w-0 items-start gap-2">
        {plain ? (
          <p data-testid="proposal-plain" className={cn("fg-body-sm min-w-0 flex-1 break-words text-fg", folded ? "truncate" : "whitespace-pre-line")} title={folded ? plain : undefined}>
            {plain}
          </p>
        ) : (
          <p data-testid="proposal-no-plain" className="fg-caption min-w-0 flex-1 italic text-muted">
            {t("conversations.proposal.noPlain")}
          </p>
        )}
        <IconButton
          icon={folded ? "chevronDown" : "chevronUp"}
          size="sm"
          aria-label={t(folded ? "conversations.proposal.unfold" : "conversations.proposal.fold")}
          aria-expanded={!folded}
          onClick={() => setFolded((f) => !f)}
          data-testid="proposal-fold"
        />
      </div>
      {folded ? null : (
        <Disclosure title={t("conversations.proposal.technical")} testId="proposal-technical">
          <div data-testid="proposal-lines" className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            <p className="fg-caption font-semibold text-fg">{summary.title}</p>
            {keyedLines(summary.lines).map(({ key, line }) => (
              <p key={key} className="fg-caption whitespace-pre-wrap break-words text-muted">
                {line}
              </p>
            ))}
            {summary.relates.length > 0 && <p className="fg-caption text-subtle">{t("conversations.proposal.relates", { records: summary.relates.join(", ") })}</p>}
          </div>
        </Disclosure>
      )}
      {proposal.canDecide ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" loading={deciding} onClick={() => onDecide("agree")}>
            {t("conversations.proposal.agree")}
          </Button>
          <Button size="sm" variant="ghost" disabled={deciding} onClick={() => onDecide("decline")}>
            {t("conversations.proposal.decline")}
          </Button>
        </div>
      ) : (
        <p className="fg-caption text-muted" role="status">
          {proposal.proposedTo.label
            ? t("conversations.proposal.waitingOn", { person: proposal.proposedTo.label })
            : t("conversations.proposal.waitingOnSomeone")}
        </p>
      )}
    </div>
  );
}
