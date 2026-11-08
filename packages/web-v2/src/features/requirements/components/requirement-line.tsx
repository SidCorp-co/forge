
// The cells a requirement fills in the shared list and its map: a short name, how many of its
// criteria pass and the stage it stands at, read from contracts once. Its wait is the shared cell.

import { REQUIREMENT_STAGE_LABELS, type RequirementStage } from "@forge/contracts/requirement-roadmap";
import { criteriaCoverageOf, type RequirementSummary } from "@forge/contracts/requirements";
import { cn } from "@/lib/utils/cn";
import { useCopy } from "@/lib/i18n/interface-language";

const STAGE_DOT: Record<RequirementStage, string> = {
  draft: "border-2 border-subtle bg-transparent",
  agreed: "bg-subtle",
  build: "bg-info-9",
  decide: "bg-accent",
  prove: "bg-ok-9 opacity-60",
  check: "bg-warn-9",
  done: "bg-ok-9",
  deferred: "bg-line-strong",
};

export function StageDot({ stage }: { stage: RequirementStage | null }) {
  if (!stage) return null;
  return <span className={cn("inline-block size-2 flex-none rounded-pill", STAGE_DOT[stage])} title={REQUIREMENT_STAGE_LABELS[stage]} data-stage={stage} />;
}

/**
 * Passing and failing criteria as one thin bar and the count, read from the row's coverage by the one
 * count the requirement's own page reads (`criteriaCoverageOf`), so the list and the record never
 * disagree (FB-583: REQ-78 read 0/7 here and 7/7 on its page). A draft says so; an ended one without
 * delivering sits in Dropped, which says it.
 */
export function Passing({ r, wide = true }: { r: RequirementSummary; wide?: boolean }) {
  const t = useCopy();
  const s = r.standing;
  const { criteria, passing, judged } = criteriaCoverageOf(s.coverage);
  if (s.state === "draft") return <span className="text-subtle">{t("requirements.line.draft")}</span>;
  if (!criteria || s.attentionGroup === "dropped") return <span className="text-subtle">—</span>;
  const failing = Math.max(0, judged - passing);
  return (
    <span className="inline-flex items-center gap-2 tabular-nums" data-testid="req-passing">
      <span className={cn("flex h-1.25 flex-none overflow-hidden rounded-sm bg-sunken", wide ? "w-21" : "w-12")}>
        <i className="block h-full bg-ok-9" style={{ width: `${(100 * passing) / criteria}%` }} />
        <i className="block h-full bg-danger" style={{ width: `${(100 * failing) / criteria}%` }} />
      </span>
      <span className="min-w-9 text-muted">{`${passing}/${criteria}`}</span>
      {failing ? <span className="text-12 text-danger">{t("requirements.line.failing", { n: failing })}</span> : null}
    </span>
  );
}

/**
 * What the row says beside its name that its group does not (FB-583): the group says where it stands,
 * so no stage word is drawn here. Left are an accept made by decision over its checklist, said as a
 * decision and never as proven (REQ-74), and a newer revision open over the current one.
 */
export function RowState({ r }: { r: RequirementSummary }) {
  const t = useCopy();
  const word = r.standing.acceptedByDecision ? t("requirements.line.acceptedByDecision") : null;
  const open = r.latestRevision;
  const opened = r.currentRevision !== null && open && open.revision > r.currentRevision && (open.state === "draft" || open.state === "proposed") ? open : null;
  // the open revision once: where the row's Waits on already names it ("accept r2"), the chip would say it twice (ISS-1131)
  const named = r.standing.attentionGroup !== "done" && opened !== null && r.standing.waitingOn.says?.act?.vars?.r === opened.revision;
  const newer = named ? null : opened;
  if (!word && !newer) return null;
  return (
    <span className="inline-flex flex-none items-center gap-1.5 text-12 text-subtle" data-testid="req-row-state">
      {word ? <span className="hidden md:inline">{word}</span> : null}
      {newer ? (
        <span className="rounded-sm bg-sunken px-1 font-mono text-12 text-muted" data-testid="req-open-revision">
          {t(newer.state === "draft" ? "requirements.line.openDraft" : "requirements.line.openProposed", { r: newer.revision })}
        </span>
      ) : null}
    </span>
  );
}

/** The name a person reads: the short one when set, else the title. The full title is the tooltip. */
export const nameOf = (r: RequirementSummary) => r.shortName ?? r.title;

const MIN = 60_000;
export function ageShort(iso: string, now: number): string {
  const m = Math.max(1, Math.floor((now - Date.parse(iso)) / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
