"use client";

// The map (REQ-29 BC-6 to BC-9): a strip of how many requirements stand at each stage, then areas as
// rows and Now, Next and Later as columns, one line per requirement. It shows no date: a date belongs
// to a forecast, and none is drawn here.

import { REQUIREMENT_STAGE_LABELS, REQUIREMENT_STAGES, ROADMAP_HORIZONS, type RequirementStage, requirementStageOf, roadmapHorizonOf } from "@forge/contracts/requirement-roadmap";
import type { RequirementSummary } from "@forge/contracts/requirements";
import Link from "next/link";
import { useReportShown } from "@/design";
import { cn } from "@/lib/utils/cn";
import { useCopy } from "@/lib/i18n/interface-language";
import { requirementHref } from "@/lib/routes/requirements";
import { nameOf, StageDot } from "./requirement-line";

const ORDER: Record<RequirementStage, number> = { decide: 0, check: 1, build: 2, prove: 3, agreed: 4, draft: 5, deferred: 6, done: 7 };
const BAR: Record<RequirementStage, string> = { draft: "bg-line-strong", agreed: "bg-subtle", build: "bg-info-9", decide: "bg-accent", prove: "bg-ok-9 opacity-60", check: "bg-warn-9", done: "bg-ok-9", deferred: "bg-line-strong" };

/** The lane names' column: the area beside its three horizons, above them on a phone. */
const LANE_NAME = "md:w-42.5 md:flex-none";

export function RequirementsMap({ rows, areas, slug, onPeek }: { rows: RequirementSummary[]; areas: { id: string; name: string }[]; slug: string; onPeek: (key: string) => void }) {
  const t = useCopy();
  const staged = rows.flatMap((r) => {
    const stage = requirementStageOf(r.standing);
    return stage ? [{ r, stage }] : [];
  });
  // accepted work counts on the strip and sits on no horizon, so the rows draw only what has one
  const placed = staged.filter((x) => roadmapHorizonOf(x.r.standing) !== null);
  useReportShown(placed.map((x) => x.r.key));
  const count = (s: RequirementStage) => staged.filter((x) => x.stage === s).length;
  const strip = REQUIREMENT_STAGES.filter((s) => count(s) > 0 || s === "done");
  const lanes = [...areas.map((a) => ({ id: a.id, name: a.name })), { id: "none", name: t("requirements.noArea") }]
    .map((a) => ({ ...a, own: placed.filter((x) => (x.r.area?.id ?? "none") === a.id) }))
    .filter((a) => a.own.length > 0);
  return (
    <div className="px-5 pb-16 max-md:px-3" data-testid="requirements-map">
      <div className="flex min-w-0 flex-wrap gap-x-0.75 gap-y-3 pt-4" data-testid="flow-strip">
        {strip.map((s) => (
          <div key={s} className="flex min-w-22 flex-col gap-1" style={{ flex: Math.max(count(s), 0.0001) }} data-stage={s}>
            <span className={cn("h-2 rounded-sm", BAR[s])} />
            {/* a label wraps rather than being cut; the counts below line up across the strip */}
            <span className="flex-1 break-words text-12 leading-tight text-muted" data-testid="flow-strip-label">
              {REQUIREMENT_STAGE_LABELS[s]}
            </span>
            <span className="text-lg font-semibold leading-none tabular-nums">{count(s)}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 border-t border-line-subtle">
        <div className="flex border-b border-line-subtle max-md:hidden">
          <span className={LANE_NAME} />
          {ROADMAP_HORIZONS.map((h) => (
            <div key={h} className="min-w-0 flex-1 px-3 pb-1.5 pt-2.5 text-12 uppercase tracking-wider text-subtle">
              {t(`requirements.map.${h}`)}
            </div>
          ))}
        </div>
        {lanes.map((a) => (
          <AreaLane key={a.id} name={a.name} own={a.own} slug={slug} onPeek={onPeek} />
        ))}
      </div>
    </div>
  );
}

function AreaLane({ name, own, slug, onPeek }: { name: string; own: { r: RequirementSummary; stage: RequirementStage }[]; slug: string; onPeek: (key: string) => void }) {
  const t = useCopy();
  return (
    <div className="grid border-b border-line-subtle md:flex">
      <div className={cn(LANE_NAME, "flex items-baseline gap-1.5 py-2.5 text-13 font-semibold max-md:pb-0")}>
        {name}
        <span className="font-medium tabular-nums text-subtle">{own.length}</span>
      </div>
      {ROADMAP_HORIZONS.map((h) => {
        const cell = own.filter((x) => roadmapHorizonOf(x.r.standing) === h).sort((a, b) => ORDER[a.stage] - ORDER[b.stage]);
        return (
          <div key={h} className="flex min-w-0 flex-1 flex-col gap-px border-l border-line-subtle py-1.5 pl-3 pr-1 max-md:border-l-0 max-md:pl-0" data-horizon={h}>
            <span className="text-12 uppercase tracking-wider text-subtle md:hidden">{t(`requirements.map.${h}`)}</span>
            {cell.length === 0 ? <span className="text-subtle">—</span> : null}
            {cell.map(({ r, stage }) => (
              <Link
                key={r.key}
                href={requirementHref(slug, r.key)}
                title={`${r.key} · ${r.title}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  onPeek(r.key);
                }}
                className="flex min-w-0 items-center gap-2 rounded px-0.5 py-0.5 text-13 hover:bg-hover"
                data-testid="map-item"
              >
                <StageDot stage={stage} />
                <span className="min-w-0 flex-1 truncate">{nameOf(r)}</span>
                {r.standing.facts.criteria && stage !== "draft" ? <span className="text-12 tabular-nums text-subtle">{`${r.standing.facts.passing}/${r.standing.facts.criteria}`}</span> : null}
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}
