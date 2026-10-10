"use client";

// The cells a requirement fills in the shared list and its map: a short name, how many of its
// criteria pass, the stage it stands at, and its wait. The stage and the wait come from contracts, once.

import { failingOf, REQUIREMENT_STAGE_LABELS, type RequirementStage, requirementStageOf, waitsLineOf } from "@forge/contracts/requirement-roadmap";
import type { RequirementSummary } from "@forge/contracts/requirements";
import { cn } from "@/lib/utils/cn";
import { useCopy } from "@/lib/i18n/interface-language";

const STAGE_DOT: Record<RequirementStage, string> = {
  draft: "border-[1.5px] border-subtle bg-transparent",
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

/** Passing and failing criteria as one thin bar and the count; a draft or a dropped one says so instead. */
export function Passing({ r, wide = true }: { r: RequirementSummary; wide?: boolean }) {
  const t = useCopy();
  const s = r.standing;
  const { criteria, passing } = s.facts;
  if (s.state === "draft") return <span className="text-subtle">{t("requirements.line.draft")}</span>;
  if (s.state === "dropped") return <span className="text-subtle">{t("requirements.line.dropped")}</span>;
  if (!criteria) return <span className="text-subtle">—</span>;
  const failing = failingOf(s);
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

export function WaitsText({ r }: { r: RequirementSummary }) {
  if (r.standing.attentionGroup === "done") return null;
  const w = waitsLineOf(r.standing);
  // an act may name keys and versions, so it wraps rather than being cut (live dev.227, 1440 px)
  return <span className={cn("min-w-0 break-words text-13 leading-snug", w.kind === "you" ? "font-medium text-accent-text" : "text-muted")} data-testid="req-waits">{w.text}</span>;
}

/**
 * Where the row stands in a word or two (REQ-4 BC-13): its stage, which folds status and delivery
 * phase into the one reading the map uses (REQ-29), and the newer revision open over the current one.
 * A draft says Draft in Passing already, so it carries no stage word here; at phone width the dot
 * stands for the word, so the name keeps its room.
 */
export function RowState({ r }: { r: RequirementSummary }) {
  const t = useCopy();
  const stage = requirementStageOf(r.standing);
  const word = stage && stage !== "draft" ? REQUIREMENT_STAGE_LABELS[stage] : null;
  const open = r.latestRevision;
  const newer = r.currentRevision !== null && open && open.revision > r.currentRevision && (open.state === "draft" || open.state === "proposed") ? open : null;
  if (!word && !newer) return null;
  return (
    <span className="inline-flex flex-none items-center gap-1.5 text-12 text-subtle" data-testid="req-row-state">
      {word ? (
        <>
          <StageDot stage={stage} />
          <span className="hidden md:inline">{word}</span>
        </>
      ) : null}
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
