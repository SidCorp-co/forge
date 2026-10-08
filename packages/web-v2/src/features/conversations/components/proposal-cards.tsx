"use client";

// A write a chat turn proposed waits here, above the composer, until the person it answers agrees
// (REQ-30 BC-4, workflow chat-turn step confirm): what it would record, what it relates to, and for
// that person alone Record it / Decline. Everyone else in the room reads whom it waits on. Once it
// is decided, core says so in the thread, and the card goes.

import type { ChatProposalView } from "@forge/contracts/chat-proposals";
import { Button } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useConversationProposals, useDecideProposal } from "../hooks";

/** The lines a card shows of what would be written; the rest is in the record once it is written. */
const SHOWN_LINES = 3;

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
      className="flex flex-none flex-col gap-2 border-t border-line bg-surface px-4 py-3"
    >
      {pending.map((p) => (
        <ProposalCard
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

export function ProposalCard({
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
  return (
    <div data-testid="proposal-card" data-kind={proposal.kind} className="flex flex-col gap-1.5 border-l-2 border-line pl-3">
      <p className="fg-body-sm font-semibold text-fg">{summary.title}</p>
      {summary.lines.slice(0, SHOWN_LINES).map((line) => (
        <p key={line} className="fg-caption line-clamp-2 text-muted">
          {line}
        </p>
      ))}
      {summary.relates.length > 0 && (
        <p className="fg-caption text-subtle">
          {t("conversations.proposal.relates", { records: summary.relates.join(", ") })}
        </p>
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
