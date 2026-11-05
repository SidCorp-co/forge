// One decision on the Approvals page, read as a decision (REQ-48 BC-11): the subject's title (its key the
// title's tooltip, never text beside it, ISS-903), then what the agent proposes as a verb and its object
// (or what is asked, where a person asked it), then one chip, whether the agent recommends it, its tags
// that chip's hover (the peek draws them in full), and on the right how long it has waited and the ✓ / ✕
// that decide it in place. Flat:
// a hairline under each row, the open one marked by a left rule. A decision with no proposal names the
// answer its ✓ sends on the ✓ itself, and how many others its peek offers (ISS-539): a row never sends
// an answer the person cannot see. Nor words: where the ✓ sends a reason as it stands, the row shows
// it before the press, since it is recorded under the person's name (REQ-4 BC-16, ISS-645 r2).

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import { Button, Checkbox, IconButton, StatusChip } from "@/design";
import { wordsAsItStands } from "@/features/needs-you";
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

/** The row's one chip: stuck, else whether the agent recommends it; the proposal's tags are its hover. */
function DecisionChip({ d }: { d: NeedsYouDecision }) {
  const t = useCopy();
  const tags = (d.proposal?.tags ?? []).map((tag) => tag.text);
  const recommends = d.proposal ? t(d.proposal.recommends ? "approvals.tag.recommends" : "approvals.tag.checkFirst") : null;
  if (d.stuck) return <StatusChip tone="err" label={t("approvals.tag.stuck")} reason={[recommends, ...tags].filter(Boolean).join(" · ") || null} testId="approval-tags" />;
  if (!d.proposal) return null;
  return <StatusChip tone={d.proposal.recommends ? "ready" : "you"} label={recommends} reason={tags.join(" · ") || null} testId="approval-tags" />;
}

/** A question's row reads its asker's plain text, first line; or says the asker wrote none (ISS-1006). */
function RowPlain({ plain }: { plain: string | null }) {
  const t = useCopy();
  const first = plain?.split("\n").find((line) => line.trim())?.trim();
  return first ? <span className="text-fg" data-testid="approval-row-plain">{first}</span> : <span className="italic" data-testid="approval-row-no-plain">{t("approvals.peek.noPlain")}</span>;
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

/** The words the row's ✓ records as the person's reason, once: an open row's peek says them under Why. */
function SentReason({ d, open }: Pick<RowProps, "d" | "open">) {
  const t = useCopy();
  const approve = approveOf(d);
  const words = approve ? wordsAsItStands(approve) : null;
  if (!words || (open && !d.proposal)) return null;
  return (
    <span className="block w-full min-w-0 truncate text-13 text-muted" title={words} data-testid="approval-reason">
      <span className="font-semibold text-fg">{t("approvals.reason")}</span> {words}
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
      data-key={d.key}
      data-topic={d.topic}
    >
      <div className="pt-0.5">
        <Checkbox checked={selected} onChange={onSelect} ariaLabel={t("approvals.selectRow", { key: d.key })} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <button type="button" className="flex min-w-0 cursor-pointer flex-col gap-1 text-left" onClick={onOpen} data-testid="approval-open">
        <span className="block w-full min-w-0 truncate text-14 font-medium text-fg" title={d.key} data-testid="approval-title">
          {d.title || d.key}
        </span>
        <span className="block w-full min-w-0 truncate text-13 text-muted" data-testid="approval-proposal" title={d.plain ?? undefined}>
          {d.proposal ? (
            <>
              <span className="font-semibold text-fg">{d.proposal.verb}</span> {d.proposal.what}
            </>
          ) : d.plain !== undefined ? (
            <RowPlain plain={d.plain} />
          ) : (
            d.question
          )}
        </span>
        <SentReason d={d} open={open} />
        {d.mockup ? <MockupStanding m={d.mockup} /> : null}
      </button>
      {d.stuck || d.proposal ? (
        <span className="flex">
          <DecisionChip d={d} />
        </span>
      ) : null}
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
