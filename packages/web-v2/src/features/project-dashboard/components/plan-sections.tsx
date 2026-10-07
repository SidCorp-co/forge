"use client";

// What lands this week and what is late, as flush rows on hairlines. Times are core's forecast read
// in the viewer's timezone; "late" is core's `ForecastLate`, never decided here. A row waiting on a
// person names who and not a time.

import Link from "next/link";
import { SectionTitle } from "@/design/primitives/heading";
import { EtaCell } from "@/features/forecast/components/eta-cell";
import type { EtaClock } from "@/features/forecast/eta";
import { spanText } from "@/features/forecast/text";
import type { PlanRow } from "../ba-derive";

const GRID = "grid grid-cols-[84px_minmax(0,1fr)_minmax(0,200px)] items-center gap-x-3.5 max-md:grid-cols-[auto_minmax(0,1fr)]";
const ROW = `${GRID} min-h-[44px] border-b border-line-subtle py-1.5`;
const KIND_LABEL = { requirement: "Requirement", feedback: "Feedback", release: "Release" } as const;

function Key({ row }: { row: PlanRow }) {
  return (
    <Link className="font-mono text-12-5 font-semibold text-link hover:underline" href={row.href} title={KIND_LABEL[row.kind]}>
      {row.key}
    </Link>
  );
}

function lateText(row: PlanRow): string {
  const l = row.late;
  if (!l) return "";
  const by = spanText(l.byMinutes);
  if (l.reason === "p85_passed") return `${by} past the latest similar work took`;
  const who = row.eta?.kind === "waits" ? row.eta.who : "a person";
  return `Waiting on ${who} · ${by} over a day`;
}

export function LandsThisWeek({ rows, clock }: { rows: PlanRow[]; clock: EtaClock }) {
  return (
    <section aria-label="Lands this week" data-testid="lands-this-week">
      <SectionTitle className="fg-h3 mb-2">Lands this week{rows.length > 0 ? ` ${rows.length}` : ""}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-13 text-muted">Nothing is forecast to land this week.</p>
      ) : (
        <ul className="m-0 list-none border-t border-line-subtle p-0">
          {rows.map((r) => (
            <li key={`${r.kind}:${r.key}`} className={ROW} data-testid="plan-row" data-key={r.key}>
              <Key row={r} />
              <span className="min-w-0 truncate text-13 text-fg max-md:col-span-2 max-md:row-start-2">{r.title}</span>
              <EtaCell eta={r.eta} clock={clock} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LateItems({ rows }: { rows: PlanRow[] }) {
  return (
    <section aria-label="Late" data-testid="late-items">
      <SectionTitle className="fg-h3 mb-2">Late{rows.length > 0 ? ` ${rows.length}` : ""}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-13 text-muted">Nothing is running past its estimate or waiting on a person for over a day.</p>
      ) : (
        <ul className="m-0 list-none border-t border-line-subtle p-0">
          {rows.map((r) => (
            <li key={`${r.kind}:${r.key}`} className={ROW} data-testid="late-row" data-key={r.key}>
              <Key row={r} />
              <span className="min-w-0 truncate text-13 text-fg max-md:col-span-2 max-md:row-start-2">{r.title}</span>
              <span className="text-right text-12-5 text-[var(--accent-text)] max-md:col-start-2 max-md:text-left" data-testid="late-by">
                {lateText(r)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
