// One decision on the Approvals page, read as a decision (REQ-48 BC-11): the key and the subject's title,
// then what the agent proposes as a verb and its object (or what is asked, where a person asked it),
// then its tags, and on the right how long it has waited and the ✓ / ✕ that decide it in place. Flat:
// a hairline under each row, the open one marked by a left rule. A decision with no proposal names the
// answer its ✓ sends on the ✓ itself, and how many others its peek offers (ISS-539): a row never sends
// an answer the person cannot see.

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { Button, Checkbox, IconButton } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { approveOf, declineOf, otherAnswersOf } from "../derive";
import { MockupStanding, RowMockup } from "./approval-mockup";

const TAG_TONE = {
  plain: "bg-sunken text-muted",
  ok: "bg-ok-3 text-ok-11",
  warn: "bg-warn-3 text-warn-11",
  danger: "bg-danger-3 text-danger-11",
} as const;

export function Tag({ tone, children }: { tone: keyof typeof TAG_TONE; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-sm px-1.5 py-px text-12 font-medium", TAG_TONE[tone])}>{children}</span>;
}

/** Whether the agent recommends it, then the proposal's own tags; a person's question carries its stuck mark only. */
export function DecisionTags({ d }: { d: NeedsYouDecision }) {
  const t = useCopy();
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="approval-tags">
      {d.stuck ? <Tag tone="danger">{t("approvals.tag.stuck")}</Tag> : null}
      {d.proposal ? <Tag tone={d.proposal.recommends ? "ok" : "warn"}>{t(d.proposal.recommends ? "approvals.tag.recommends" : "approvals.tag.checkFirst")}</Tag> : null}
      {(d.proposal?.tags ?? []).map((tag) => (
        <Tag key={tag.text} tone={tag.tone}>
          {tag.text}
        </Tag>
      ))}
    </span>
  );
}

interface RowProps {
  d: NeedsYouDecision;
  open: boolean;
  selected: boolean;
  onOpen: () => void;
  onSelect: (on: boolean) => void;
  onApprove: () => void;
  onDecline: () => void;
}

/** A decision with no proposal: the ✓ carrying the words of the answer it sends, and the rest behind its peek. */
function NamedAnswer({ d, onOpen, onApprove }: Pick<RowProps, "d" | "onOpen" | "onApprove">) {
  const t = useCopy();
  const approve = approveOf(d);
  const others = otherAnswersOf(d).length;
  const rest = approve ? (others === 1 ? t("approvals.otherAnswers", { n: others }) : t("approvals.otherAnswers.many", { n: others })) : t("approvals.answers", { n: others });
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2" data-testid="approval-answer">
      {approve ? (
        <Button size="sm" icon="check" className="min-w-0 max-w-full" aria-label={t("approvals.sendRow", { label: approve.label, key: d.key })} onClick={onApprove} data-testid="approval-approve">
          <span className="truncate">{approve.label}</span>
        </Button>
      ) : null}
      {others > 0 ? (
        <button type="button" className="text-12 font-semibold text-link hover:underline" onClick={onOpen} data-testid="approval-other-answers">
          {rest}
        </button>
      ) : null}
    </span>
  );
}

export function PendingDecision({ d, open, selected, onOpen, onSelect, onApprove, onDecline }: RowProps) {
  const t = useCopy();
  const time = useTimeFormat();
  const approve = approveOf(d);
  const decline = declineOf(d);
  return (
    <li
      className={cn(
        "flex gap-3 border-b border-l-2 border-b-line-subtle px-4 py-3 transition-colors hover:bg-hover",
        open ? "border-l-accent bg-hover" : "border-l-transparent",
        selected && !open && "bg-accent-tint",
      )}
      data-testid="approval-row"
      data-row-key={d.id}
      data-topic={d.topic}
    >
      <div className="pt-0.5">
        <Checkbox checked={selected} onChange={onSelect} ariaLabel={t("approvals.selectRow", { key: d.key })} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <button type="button" className="flex min-w-0 cursor-pointer flex-col gap-1 text-left" onClick={onOpen} data-testid="approval-open">
        <span className="flex w-full min-w-0 items-baseline gap-2">
          <span className="shrink-0 whitespace-nowrap font-mono text-12 text-link">{d.key}</span>
          <span className="min-w-0 truncate text-14 font-medium text-fg">{d.title || d.key}</span>
        </span>
        <span className="block w-full min-w-0 truncate text-13 text-muted" data-testid="approval-proposal">
          {d.proposal ? (
            <>
              <span className="font-semibold text-fg">{d.proposal.verb}</span> {d.proposal.what}
            </>
          ) : (
            d.question
          )}
        </span>
        <DecisionTags d={d} />
        {d.mockup ? <MockupStanding m={d.mockup} /> : null}
      </button>
      {d.proposal ? null : <NamedAnswer d={d} onOpen={onOpen} onApprove={onApprove} />}
      </div>
      <RowMockup d={d} />
      <div className="flex items-start gap-1">
        <span className="whitespace-nowrap pt-1 font-mono text-12 text-subtle" title={d.touchedAt ?? undefined}>
          {d.touchedAt ? time.age(d.touchedAt) : ""}
        </span>
        {approve && d.proposal ? <IconButton icon="check" size="sm" aria-label={t("approvals.approveRow", { key: d.key })} onClick={onApprove} data-testid="approval-approve" /> : null}
        {decline ? <IconButton icon="x" size="sm" aria-label={t("approvals.declineRow", { key: d.key })} onClick={onDecline} data-testid="approval-decline" /> : null}
      </div>
    </li>
  );
}
