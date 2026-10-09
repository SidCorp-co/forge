"use client";

// One requirement as the Requirements list and its map draw it: a short name, how many of its
// criteria pass, and the stage it stands at. The stage and the wait come from contracts, once.

import { failingOf, REQUIREMENT_STAGE_LABELS, type RequirementStage, waitsLineOf } from "@forge/contracts/requirement-roadmap";
import type { RequirementSummary } from "@forge/contracts/requirements";
import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import { useCopy } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";

const STAGE_DOT: Record<RequirementStage, string> = {
  draft: "border-[1.5px] border-subtle bg-transparent",
  agreed: "bg-subtle",
  build: "bg-cobalt",
  decide: "bg-accent",
  prove: "bg-green opacity-60",
  check: "bg-amber",
  done: "bg-green",
  deferred: "bg-line-strong",
};

export function StageDot({ stage }: { stage: RequirementStage | null }) {
  if (!stage) return null;
  return <span className={cn("inline-block size-2 flex-none rounded-full", STAGE_DOT[stage])} title={REQUIREMENT_STAGE_LABELS[stage]} data-stage={stage} />;
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
      <span className={cn("flex h-[5px] flex-none overflow-hidden rounded-sm bg-sunken", wide ? "w-[84px]" : "w-12")}>
        <i className="block h-full bg-green" style={{ width: `${(100 * passing) / criteria}%` }} />
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
  return <span className={cn("truncate text-13", w.kind === "you" ? "font-medium text-accent-text" : "text-muted")}>{w.text}</span>;
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

export function RequirementLine({ r, slug, now, selected, onPeek }: { r: RequirementSummary; slug: string; now: number; selected: boolean; onPeek: (key: string) => void }) {
  const href = requirementHref(slug, r.key);
  return (
    <Link
      href={href}
      title={r.title}
      data-testid="list-row"
      data-key={r.key}
      aria-current={selected || undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onPeek(r.key);
      }}
      className={cn(
        "grid min-h-9 items-center gap-x-4 gap-y-0.5 rounded-md px-1 py-1.5 hover:bg-hover",
        "grid-cols-[52px_minmax(0,1fr)_auto] [grid-template-areas:'k_t_a'_'._p_p'_'._w_w']",
        "md:grid-cols-[56px_minmax(0,1fr)_190px_220px_44px] md:[grid-template-areas:none]",
        selected && "bg-hover",
      )}
    >
      <span className="font-mono text-12 text-subtle [grid-area:k] md:[grid-area:auto]">{r.key}</span>
      <span className="truncate [grid-area:t] md:[grid-area:auto]">{nameOf(r)}</span>
      <span className="text-12-5 [grid-area:p] md:[grid-area:auto]">
        <Passing r={r} />
      </span>
      <span className="flex min-w-0 [grid-area:w] md:[grid-area:auto]">
        <WaitsText r={r} />
      </span>
      <span className="text-right font-mono text-12 text-subtle [grid-area:a] md:[grid-area:auto]">{ageShort(r.standing.touchedAt, now)}</span>
    </Link>
  );
}
