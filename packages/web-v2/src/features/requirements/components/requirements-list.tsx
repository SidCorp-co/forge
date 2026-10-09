"use client";

// The list (REQ-29 BC-4, BC-5): one line per requirement, in groups by attention or by area, the
// finished group folded. Group headings carry a count and nothing else.

import { REQUIREMENT_ATTENTION_GROUPS, type RequirementSummary } from "@forge/contracts/requirements";
import { useState } from "react";
import { useReportShown } from "@/design";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import { RequirementLine } from "./requirement-line";

export type ListGrouping = "attention" | "area";

interface Group {
  id: string;
  label: string;
  rows: RequirementSummary[];
}

export function listGroupsOf(rows: RequirementSummary[], by: ListGrouping, areas: { id: string; name: string }[], label: (g: string) => string, noArea: string): Group[] {
  const newest = (a: RequirementSummary, b: RequirementSummary) => b.standing.touchedAt.localeCompare(a.standing.touchedAt);
  const groups: Group[] =
    by === "attention"
      ? REQUIREMENT_ATTENTION_GROUPS.map((g) => ({ id: g, label: label(g), rows: rows.filter((r) => r.standing.attentionGroup === g) }))
      : [
          ...areas.map((a) => ({ id: a.id, label: a.name, rows: rows.filter((r) => r.area?.id === a.id) })),
          { id: "none", label: noArea, rows: rows.filter((r) => !r.area) },
        ];
  return groups.filter((g) => g.rows.length > 0).map((g) => ({ ...g, rows: [...g.rows].sort(newest) }));
}

export function RequirementsList({ groups, slug, now, selected, onPeek }: { groups: Group[]; slug: string; now: number; selected: string | null; onPeek: (key: string) => void }) {
  const t = useCopy();
  const [closed, setClosed] = useState<Record<string, boolean>>({ done: true });
  // the chat reads which rows are on screen (REQ-41 BC-6)
  useReportShown(groups.filter((g) => !(closed[g.id] ?? false)).flatMap((g) => g.rows.map((r) => r.key)));
  if (groups.length === 0) return <p className="px-5 py-10 text-13 text-muted">{t("requirements.noMatch")}</p>;
  return (
    <div data-testid="requirements-list" className="px-5 pb-16 max-md:px-3">
      <div className="hidden grid-cols-[56px_minmax(0,1fr)_190px_220px_44px] gap-x-4 px-1 pb-1.5 pt-3 text-11 uppercase tracking-wider text-subtle md:grid">
        <span>{t("requirements.col.key")}</span>
        <span>{t("requirements.col.name")}</span>
        <span>{t("requirements.col.passing")}</span>
        <span>{t("requirements.col.waits")}</span>
        <span className="text-right">{t("requirements.col.age")}</span>
      </div>
      {groups.map((g) => {
        const shut = closed[g.id] ?? false;
        return (
          <section key={g.id} className="border-t border-line-subtle" data-testid="requirements-group" data-group={g.id}>
            <button type="button" aria-expanded={!shut} onClick={() => setClosed((c) => ({ ...c, [g.id]: !shut }))} className="flex w-full items-center gap-2 pb-1.5 pt-3 text-left text-13 font-semibold">
              <span className="text-11 text-subtle">{shut ? "▸" : "▾"}</span>
              {g.label}
              <span className="font-medium tabular-nums text-subtle">{g.rows.length}</span>
            </button>
            {shut ? null : g.rows.map((r) => <RequirementLine key={r.key} r={r} slug={slug} now={now} selected={selected === r.key} onPeek={onPeek} />)}
          </section>
        );
      })}
    </div>
  );
}

/** The label for an attention group. */
export function useAttentionLabel() {
  const label = useLabel();
  return (g: string) => label("requirementAttention", g);
}
