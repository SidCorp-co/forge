"use client";

// What lands this week and what is late, as flush rows on hairlines. Times are core's forecast read
// in the viewer's timezone; "late" is core's `ForecastLate`, never decided here. A row waiting on a
// person names who and not a time.

import type { Said } from "@forge/contracts/said";
import Link from "next/link";
import { SectionTitle } from "@/design/primitives/heading";
import { EtaCell } from "@/features/forecast/components/eta-cell";
import type { EtaClock } from "@/features/forecast/eta";
import { spanText } from "@/features/forecast/text";
import { releaseHref } from "@/lib/routes/releases";
import type { PlanRow } from "../ba-derive";
import { useCopy } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { said } from "@/lib/i18n/said";

const GRID = "grid grid-cols-[84px_minmax(0,1fr)_minmax(0,200px)] items-center gap-x-3.5 max-md:grid-cols-[auto_minmax(0,1fr)]";
const ROW = `${GRID} min-h-[44px] border-b border-line-subtle py-1.5`;
const KIND_KEY = { requirement: "dash.kind.requirement", feedback: "dash.kind.feedback", release: "dash.kind.release" } as const;

function Key({ row }: { row: PlanRow }) {
  const t = useCopy();
  return (
    <Link className="font-mono text-12-5 font-semibold text-link hover:underline" href={row.href} title={t(KIND_KEY[row.kind])}>
      {row.key}
    </Link>
  );
}

function lateText(row: PlanRow, t: Copy, lang: EtaClock["lang"]): string {
  const l = row.late;
  if (!l) return "";
  const by = spanText(l.byMinutes, lang);
  if (l.reason === "p85_passed") return t("dash.latePast", { by });
  const who = row.eta?.kind === "waits" ? said(row.eta.who, lang) : t("dash.aPerson");
  return t("dash.lateWaiting", { who, by });
}

type Block = { kind: "row"; row: PlanRow } | { kind: "cut"; version: string; who: Said; rows: PlanRow[] };

/** Rows waiting on the same release cut sit under one line naming the release and who cuts it; a lone one stays a row. */
export function landBlocks(rows: readonly PlanRow[]): Block[] {
  const byVersion = new Map<string, PlanRow[]>();
  for (const r of rows) if (r.release) byVersion.set(r.release.version, [...(byVersion.get(r.release.version) ?? []), r]);
  const blocks: Block[] = [];
  const placed = new Set<string>();
  for (const r of rows) {
    const same = r.release ? (byVersion.get(r.release.version) ?? []) : [];
    if (!r.release || same.length < 2) blocks.push({ kind: "row", row: r });
    else if (!placed.has(r.release.version)) {
      placed.add(r.release.version);
      blocks.push({ kind: "cut", version: r.release.version, who: r.release.who, rows: same });
    }
  }
  return blocks;
}

function PlanItem({ r, clock }: { r: PlanRow; clock: EtaClock }) {
  return (
    <li className={ROW} data-testid="plan-row" data-key={r.key}>
      <Key row={r} />
      <span className="min-w-0 truncate text-13 text-fg max-md:col-span-2 max-md:row-start-2">{r.title}</span>
      <EtaCell eta={r.eta} clock={clock} />
    </li>
  );
}

export function LandsThisWeek({ rows, clock, slug }: { rows: PlanRow[]; clock: EtaClock; slug: string }) {
  const t = useCopy();
  return (
    <section aria-label={t("dash.landsThisWeek")} data-testid="lands-this-week">
      <SectionTitle className="fg-h3 mb-2">{t("dash.landsThisWeek")}{rows.length > 0 ? ` ${rows.length}` : ""}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-13 text-muted">{t("dash.landsEmpty")}</p>
      ) : (
        <ul className="m-0 list-none border-t border-line-subtle p-0">
          {landBlocks(rows).map((b) =>
            b.kind === "row" ? (
              <PlanItem key={`${b.row.kind}:${b.row.key}`} r={b.row} clock={clock} />
            ) : (
              <li key={`cut:${b.version}`} data-testid="lands-when-cut">
                <details className="border-b border-line-subtle">
                  <summary className="cursor-pointer select-none py-2.5 text-13 font-semibold text-fg">
                    {t("dash.landWhenA", { count: b.rows.length })}{" "}
                    <Link className="text-link hover:underline" href={releaseHref(slug, b.version)} onClick={(e) => e.stopPropagation()}>
                      {b.version}
                    </Link>{" "}
                    {t("dash.landWhenB", { who: said(b.who, clock.lang) })}
                  </summary>
                  <ul className="m-0 list-none p-0">
                    {b.rows.map((r) => (
                      <PlanItem key={`${r.kind}:${r.key}`} r={r} clock={clock} />
                    ))}
                  </ul>
                </details>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

export function LateItems({ rows, clock }: { rows: PlanRow[]; clock: EtaClock }) {
  const t = useCopy();
  return (
    <section aria-label={t("dash.late")} data-testid="late-items">
      <SectionTitle className="fg-h3 mb-2">{t("dash.late")}{rows.length > 0 ? ` ${rows.length}` : ""}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-13 text-muted">{t("dash.lateEmpty")}</p>
      ) : (
        <ul className="m-0 list-none border-t border-line-subtle p-0">
          {rows.map((r) => (
            <li key={`${r.kind}:${r.key}`} className={ROW} data-testid="late-row" data-key={r.key}>
              <Key row={r} />
              <span className="min-w-0 truncate text-13 text-fg max-md:col-span-2 max-md:row-start-2">{r.title}</span>
              <span className="text-right text-12-5 text-[var(--accent-text)] max-md:col-start-2 max-md:text-left" data-testid="late-by">
                {lateText(r, t, clock.lang)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
