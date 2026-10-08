"use client";

// A write a chat turn proposed waits here, above the composer, until the person it answers agrees
// (REQ-30 BC-4, workflow chat-turn step confirm): what it would record, what it relates to, and for
// that person alone Record it / Decline. Everyone else in the room reads whom it waits on. Once it
// is decided, core says so in the thread, and the card goes. The card shows the WHOLE proposal —
// every line core summarised from the held call, none clipped — since a person agrees only to what
// they could read; a long one scrolls inside the card rather than being cut short.

import type { ChatProposalView } from "@forge/contracts/chat-proposals";
import { Button } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
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
      {summary.lines.length > 0 && (
        <div data-testid="proposal-lines" className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {keyedLines(summary.lines).map(({ key, line }) => (
            <p key={key} className="fg-caption whitespace-pre-wrap break-words text-muted">
              {line}
            </p>
          ))}
        </div>
      )}
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
