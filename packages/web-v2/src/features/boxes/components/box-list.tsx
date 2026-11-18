// The project's boxes (ISS-1276 c7, mockup MK-12): each row names what it tests (the issue, or By
// hand), its mode and size, who holds it and for how long, and the criterion under test or why it
// stopped: failed, or closed by the sweep once nothing used it (ISS-1335). The waiting ones are the queue below, each with its place and the health reason it waits on.

import type { BoxRecord } from "@forge/contracts/boxes";
import { StatusChip, ToneBadge, useNow } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useBoxIssueLabel } from "../hooks";
import { clock, holderWords, isLive, STATE_TONE } from "../labels";

/** What a box tests, as its row and head name it: the issue's key and title, or By hand. */
export function useBoxLabel(box: BoxRecord): string {
  const t = useCopy();
  const issue = useBoxIssueLabel(box.issueId).data;
  if (!box.issueId) return t("boxes.row.byHand");
  return issue ? [issue.key, issue.title].filter(Boolean).join(" · ") : "…";
}

function BoxEntry({ box, me, selected, onSelect }: { box: BoxRecord; me: string | undefined; selected: boolean; onSelect: (id: string) => void }) {
  const t = useCopy();
  const label = useBoxLabel(box);
  const now = useNow(1000, isLive(box));
  const held = box.heldSince && isLive(box) ? clock(now - Date.parse(box.heldSince)) : null;
  // an agent's hold is the state's own word on the badge; only a person is named
  const who = box.holder?.kind === "person" ? holderWords(box, me, t) : null;
  const line = [t(`boxes.mode.${box.mode}`), who, held].filter(Boolean).join(" · ");
  const why = box.failure ? t(`boxes.failure.${box.failure}`) : box.closedWhy === "idle" ? t("boxes.closedWhy.idle") : box.criterion ? t("boxes.row.criterion", { n: box.criterion }) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(box.id)}
        aria-current={selected ? "true" : undefined}
        data-testid="box-row"
        data-state={box.state}
        className={`grid w-full gap-0.5 border-b border-line-subtle px-3 py-2 text-left hover:bg-hover focus-visible:shadow-focus focus-visible:outline-none ${selected ? "border-l-2 border-l-link bg-sunken" : ""}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ToneBadge tone={STATE_TONE[box.state]} label={t(`boxes.state.${box.state}`)} title={t(`boxes.state.${box.state}`)} value={box.state} pulse={isLive(box)} />
          <span className="min-w-0 truncate text-13 font-semibold">{label}</span>
        </span>
        <span className="truncate text-12 text-muted" data-testid="box-row-line">
          {line}
        </span>
        {why ? <span className="text-12 text-muted">{why}</span> : null}
      </button>
    </li>
  );
}

export function BoxList({ boxes, me, selected, onSelect }: { boxes: readonly BoxRecord[]; me: string | undefined; selected: string | null; onSelect: (id: string) => void }) {
  const t = useCopy();
  const listed = boxes.filter((b) => b.state !== "waiting");
  if (listed.length === 0) return <p className="px-3 py-4 text-13 text-muted">{t("boxes.list.empty")}</p>;
  return (
    <ul aria-label={t("boxes.list.label")} data-testid="box-list">
      {listed.map((b) => (
        <BoxEntry key={b.id} box={b} me={me} selected={b.id === selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function WaitingRequest({ box }: { box: BoxRecord }) {
  const t = useCopy();
  const label = useBoxLabel(box);
  return (
    <li className="border-b border-line-subtle px-3 py-2" data-testid="box-queue-row">
      {/* its place, and the health reason it waits on behind it, on hover, focus or a tap (ui-copy-rule) */}
      <span className="flex min-w-0 items-center gap-2 text-13">
        <StatusChip tone="blocked" label={t("boxes.queue.place", { n: box.queue?.position ?? 0 })} value="waiting" reason={box.queue?.reason ?? null} testId="box-queue-place" />
        <span className="min-w-0 truncate">{label}</span>
        <span className="flex-none text-12 text-muted">{t(`boxes.mode.${box.mode}`)}</span>
      </span>
    </li>
  );
}

/** The waiting requests in their places, 1 first; nothing where none waits. */
export function BoxQueue({ boxes }: { boxes: readonly BoxRecord[] }) {
  const t = useCopy();
  const waiting = boxes.filter((b) => b.state === "waiting").sort((a, b) => (a.queue?.position ?? 0) - (b.queue?.position ?? 0));
  if (waiting.length === 0) return null;
  return (
    <section aria-label={t("boxes.queue.title")} data-testid="box-queue" className="border-t border-line-subtle">
      <h2 className="px-3 pb-1 pt-3 text-12 font-semibold uppercase tracking-wide text-muted">{t("boxes.queue.title")}</h2>
      <ol>
        {waiting.map((b) => (
          <WaitingRequest key={b.id} box={b} />
        ))}
      </ol>
    </section>
  );
}
