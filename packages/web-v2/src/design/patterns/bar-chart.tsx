// A bar chart that carries its own numbers (REQ-43 BC-16): each bar prints the value its own row
// carries (`cap_<series>`), an average sits as a dashed line labelled in the right margin, never over
// a bar, and the same numbers read as a table to a screen reader. Drawn once its frame has a laid-out
// width. One y-axis, no table toggle, no data expander on screen.

import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import { Table, TBody, TD, TH, THead, TR } from "../primitives/table";
import { useLaidOutWidth } from "./timeline";

const TICK = { fill: "var(--fg-muted)", fontSize: 11 } as const;
const AXIS = { stroke: "var(--border-strong)" } as const;
const MARGIN = { top: 18, right: 8, bottom: 0, left: -12 };
/** Room on the right for an average's label, so it never sits over a bar. */
const AVERAGE_MARGIN = { ...MARGIN, right: 64 };
const CHART_HEIGHT = 208;
const TOP: [number, number, number, number] = [3, 3, 0, 0];
const VALUE = { fill: "var(--fg-default)", fontSize: 11, fontWeight: 600 } as const;
/** A bar's printed value: its number, or nothing on a bar that carries none. */
const markText = (v: unknown) => (typeof v === "number" ? String(v) : "");

/** What a chart says, as a table only a screen reader reads. */
export function ReaderTable({ caption, head, rows, testId = "chart-table" }: { caption: string; head: string[]; rows: (string | number)[][]; testId?: string }) {
  return (
    <div className="sr-only" data-testid={testId}>
      <Table aria-label={caption}>
        <THead>
          <TR>
            {head.map((h) => (
              <TH key={h} scope="col">
                {h}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={String(r[0])}>
              {r.map((c, i) => (i === 0 ? <TH key={head[i]} scope="row">{c}</TH> : <TD key={head[i]}>{c}</TD>))}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

export function TipBox({ lines }: { lines: string[] }) {
  return (
    <div className="rounded-md bg-neutral-12 px-2 py-1 text-12 text-on-accent">
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

/**
 * The chart is drawn once its frame has a laid-out width, at that width: drawn before the page around it
 * had one, it measured nothing and stayed blank until the window next resized.
 */
export function MeasuredChart({ config, children }: { config: ChartConfig; children: ReactNode }) {
  const [frame, width] = useLaidOutWidth<HTMLDivElement>();
  return (
    <div ref={frame} aria-hidden className="h-52 w-full min-w-0">
      {width ? (
        <ChartContainer config={config} className="aspect-auto h-52 w-full" initialDimension={{ width, height: CHART_HEIGHT }}>
          {children}
        </ChartContainer>
      ) : null}
    </div>
  );
}

export function ChartPart({ title, legend, children, testId }: { title: string; legend?: ReactNode; children: ReactNode; testId: string }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <h2 className="m-0 text-14 font-semibold text-fg">{title}</h2>
      {legend}
      {children}
    </section>
  );
}

export interface BarSeries {
  key: string;
  label: string;
  /** Its fill: a tone's dot (`toneFill`) for a series that means something, else a chart token. */
  fill: string;
}

export function ChartLegend({ series, testId = "chart-legend" }: { series: readonly BarSeries[]; testId?: string }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-12 text-muted" data-testid={testId}>
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm" style={{ background: s.fill }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** A bar's row: its axis tick, and each series' value and `cap_<key>` under the series' key. */
export interface BarRow {
  tick: string;
}

export interface BarChartFigureProps<R extends BarRow> {
  title: string;
  testId: string;
  /** One per bar (or stack): its axis tick, each series' value, and each series' `cap_<key>`. */
  rows: readonly R[];
  series: readonly BarSeries[];
  /** Series stack into one bar; else they stand side by side. */
  stacked?: boolean;
  average?: { value: number; label: string } | null;
  /** The lines the hover card says for a row. */
  tipOf: (row: R) => string[];
  /** Said where every value is zero, in place of the chart. */
  emptyText: string;
  reader: { head: string[]; rows: (string | number)[][]; testId?: string };
  legendTestId?: string;
}

const valueOf = (row: BarRow, key: string) => {
  const v = (row as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : 0;
};

export function BarChartFigure<R extends BarRow>({ title, testId, rows, series, stacked = false, average, tipOf, emptyText, reader, legendTestId }: BarChartFigureProps<R>) {
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.fill }]));
  const empty = rows.every((r) => series.every((s) => valueOf(r, s.key) === 0));
  return (
    <ChartPart title={title} testId={testId} legend={!empty && series.length > 1 ? <ChartLegend series={series} testId={legendTestId} /> : undefined}>
      {empty ? (
        <p className="py-8 text-13 text-subtle">{emptyText}</p>
      ) : (
        <MeasuredChart config={config}>
          <BarChart data={[...rows]} margin={average ? AVERAGE_MARGIN : MARGIN} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
            <XAxis dataKey="tick" tickLine={false} axisLine={AXIS} tick={TICK} interval="preserveStartEnd" />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={TICK} width={40} />
            <Tooltip
              cursor={{ fill: "var(--bg-hover)" }}
              content={({ active, payload }) => {
                const row = active ? (payload?.[0]?.payload as R | undefined) : undefined;
                return row ? <TipBox lines={tipOf(row)} /> : null;
              }}
            />
            {average ? (
              <ReferenceLine
                y={average.value}
                stroke="var(--fg-muted)"
                strokeDasharray="4 4"
                label={{ value: average.label, position: "right", fill: "var(--fg-muted)", fontSize: 11 }}
              />
            ) : null}
            {series.map((s) => (
              // a stack's top segment is whichever is drawn, so only a lone bar rounds its top
              <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} isAnimationActive={false} {...(stacked ? { stackId: "stack" } : { radius: TOP })}>
                <LabelList dataKey={`cap_${s.key}`} position="top" offset={5} {...VALUE} formatter={markText} />
              </Bar>
            ))}
          </BarChart>
        </MeasuredChart>
      )}
      <ReaderTable caption={title} head={reader.head} rows={reader.rows} testId={reader.testId} />
    </ChartPart>
  );
}
