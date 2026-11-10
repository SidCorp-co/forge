// The overview a state screen opens on (REQ-43 r3 BC-14..BC-17; owner, 2026-11-10): its few figures,
// the flow of its states each with its live count, toned by what each state means, and one chart of
// how it moves, together in one flat tone region above the list it summarises. Detail opens on hover
// or in a drawer, never in place. Flat (REQ-12 BC-1): one tone and one hairline, no card, no shadow.

import type { ReactNode } from "react";
import { shareOf } from "../chart-model";
import { Tooltip } from "../primitives/tooltip";
import { type CoverageSegment, CoverageBar } from "./facts-rail";
import { ChartPart, ReaderTable } from "./bar-chart";

/** A share drawn as a ring: the track, and the arc of `share` in the first series colour. */
export function Ring({ share, size = 44 }: { share: number; size?: number }) {
  const r = 15;
  const arc = 2 * Math.PI * r;
  return (
    <svg aria-hidden viewBox="0 0 36 36" width={size} height={size} className="flex-none" data-testid="ring">
      <circle cx="18" cy="18" r={r} fill="none" stroke="var(--bg-active)" strokeWidth="4.5" />
      {share > 0 ? (
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--chart-2)" strokeWidth="4.5" strokeLinecap="round" strokeDasharray={`${arc * Math.min(share, 1)} ${arc}`} transform="rotate(-90 18 18)" />
      ) : null}
    </svg>
  );
}

export interface BandFigure {
  key: string;
  value: string | number;
  /** One to three words: what the number counts. */
  label: string;
  /** The share a ring draws beside the figure. */
  ring?: number;
}

function Figure({ f }: { f: BandFigure }) {
  return (
    <p className="m-0 flex items-center gap-2.5" data-testid="band-figure" data-key={f.key}>
      {f.ring !== undefined ? <Ring share={f.ring} size={36} /> : null}
      <span className="flex min-w-0 flex-col">
        <span className="text-20 font-semibold leading-tight tabular-nums text-fg" data-testid="band-figure-value">
          {f.value}
        </span>
        <span className="text-12 text-muted">{f.label}</span>
      </span>
    </p>
  );
}

/**
 * A screen with no state that moves over time passes no `chart`, and its figures and flow take the
 * band's whole width: a band never invents a chart to fill its right half.
 */
export function OverviewBand({ label, figures, flow, chart, testId = "overview-band" }: { label: string; figures: readonly BandFigure[]; flow: readonly CoverageSegment[]; chart?: ReactNode; testId?: string }) {
  return (
    <section aria-label={label} className={`grid grid-cols-1 gap-x-8 gap-y-4 border-b border-line-subtle bg-sunken px-5 py-4 max-md:px-3 ${chart ? "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : ""}`} data-testid={testId}>
      <div className="flex min-w-0 flex-col justify-center gap-4">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          {figures.map((f) => (
            <Figure key={f.key} f={f} />
          ))}
        </div>
        <div data-testid="band-flow">
          {/* an empty list's flow is its bare track, so the band keeps its shape and reads zero (ui-copy-rule) */}
          {flow.some((s) => s.count > 0) ? <CoverageBar segments={flow} /> : <div aria-hidden className="h-2 rounded-pill bg-neutral-5" data-testid="band-flow-empty" />}
        </div>
      </div>
      {chart ? <div className="min-w-0">{chart}</div> : null}
    </section>
  );
}

export interface ShareRow {
  key: string;
  label: string;
  part: number;
  whole: number;
}

/**
 * A share per row as a horizontal bar, each printing its own `part/whole` at its end, so a reader
 * reads every number off the chart; the share and the counts open on hover too.
 */
export function ShareBars({ title, testId, rows, unit, emptyText, reader }: { title: string; testId: string; rows: readonly ShareRow[]; unit: string; emptyText: string; reader: { head: string[] } }) {
  const drawn = rows.filter((r) => r.whole > 0);
  return (
    <ChartPart title={title} testId={testId}>
      {drawn.length === 0 ? (
        <p className="py-8 text-13 text-subtle">{emptyText}</p>
      ) : (
        <ul aria-hidden className="m-0 grid list-none gap-2 p-0 pt-1">
          {drawn.map((r) => {
            const share = shareOf(r.part, r.whole);
            return (
              <li key={r.key} data-testid="share-row" data-key={r.key}>
                <Tooltip label={`${r.label} · ${Math.round(share * 100)}% · ${r.part}/${r.whole} ${unit}`} className="grid w-full grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-12">
                  <span className="truncate text-muted">{r.label}</span>
                  <span className="h-2 overflow-hidden rounded-pill bg-neutral-5">
                    <span className="block h-full rounded-pill" style={{ width: `${share * 100}%`, background: "var(--chart-2)" }} />
                  </span>
                  <span className="font-semibold tabular-nums text-fg" data-testid="share-row-value">
                    {r.part}/{r.whole}
                  </span>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
      <ReaderTable caption={title} head={reader.head} rows={drawn.map((r) => [r.label, r.part, r.whole])} />
    </ChartPart>
  );
}
