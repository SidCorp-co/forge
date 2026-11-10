// The two charts under the loop (REQ-43 BC-16): issues shipped per day, its highest day and today
// labelled and its average drawn as a dashed line, and feedback by week, each bar's total on it. Each
// carries its own numbers on hover; a reader who cannot see it reads the same numbers as a table.
// One y-axis each, no table toggle and no data expander on screen.

import type { HomeFeedbackWeek, HomeShipDay } from "@forge/contracts/project-home";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { type ChartConfig, ChartContainer, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { averageText, dayLabel, SERIES, shipChartOf } from "../model";

const TICK = { fill: "var(--fg-muted)", fontSize: 11 } as const;
const AXIS = { stroke: "var(--border-strong)" } as const;
const MARGIN = { top: 18, right: 8, bottom: 0, left: -12 };
const VALUE = { fill: "var(--fg-default)", fontSize: 11, fontWeight: 600 } as const;

/** What a chart says, as a table only a screen reader reads. */
function ReaderTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="sr-only" data-testid="home-chart-table">
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

function TipBox({ lines }: { lines: string[] }) {
  return (
    <div className="rounded-md bg-neutral-12 px-2 py-1 text-12 text-on-accent">
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
    </div>
  );
}

function ChartPart({ title, legend, children, testId }: { title: string; legend?: ReactNode; children: ReactNode; testId: string }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <h2 className="m-0 text-14 font-semibold text-fg">{title}</h2>
      {legend}
      {children}
    </section>
  );
}

export function ShippedChart({ days }: { days: readonly HomeShipDay[] }) {
  const t = useCopy();
  const chart = shipChartOf(days);
  const config: ChartConfig = { issues: { label: t("home.chart.issues"), color: SERIES[0] } };
  const empty = chart.points.every((p) => p.issues === 0);
  const peakLabel = (props: { x?: number | string; y?: number | string; width?: number | string; value?: unknown; index?: number }) => {
    const value = Number(props.value);
    if (props.index === undefined || !chart.labelled.has(props.index) || !value) return null;
    const x = Number(props.x) + Number(props.width) / 2;
    return (
      <text x={x} y={Number(props.y) - 5} textAnchor="middle" {...VALUE}>
        {value}
      </text>
    );
  };
  return (
    <ChartPart title={t("home.chart.shipped")} testId="home-chart-shipped">
      {empty ? (
        <p className="py-8 text-13 text-subtle">{t("home.chart.shippedNone")}</p>
      ) : (
        <div aria-hidden>
          <ChartContainer config={config} className="aspect-auto h-52 w-full" initialDimension={{ width: 480, height: 208 }}>
            <BarChart data={chart.points} margin={MARGIN} accessibilityLayer={false}>
              <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
              <XAxis dataKey="tick" tickLine={false} axisLine={AXIS} tick={TICK} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={TICK} width={40} />
              <Tooltip
                cursor={{ fill: "var(--bg-hover)" }}
                content={({ active, payload }) => {
                  const p = active ? (payload?.[0]?.payload as (HomeShipDay & { label: string }) | undefined) : undefined;
                  return p ? <TipBox lines={[p.label, t("home.chart.tipShipped", { r: p.releases, n: p.issues })]} /> : null;
                }}
              />
              <ReferenceLine
                y={chart.average}
                stroke="var(--fg-muted)"
                strokeDasharray="4 4"
                label={{ value: t("home.chart.average", { n: averageText(chart.average) }), position: "insideTopRight", fill: "var(--fg-muted)", fontSize: 11 }}
              />
              <Bar dataKey="issues" fill="var(--color-issues)" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                <LabelList dataKey="issues" content={peakLabel} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>
      )}
      <ReaderTable
        caption={t("home.chart.shipped")}
        head={[t("home.chart.day"), t("home.chart.releases"), t("home.chart.issues")]}
        rows={chart.points.map((p) => [p.label, p.releases, p.issues])}
      />
    </ChartPart>
  );
}

const OUTCOMES = ["fixed", "declined", "open"] as const;

export function FeedbackChart({ weeks }: { weeks: readonly HomeFeedbackWeek[] }) {
  const t = useCopy();
  const data = weeks.map((w) => ({ ...w, label: dayLabel(w.week), total: w.fixed + w.declined + w.open }));
  const config: ChartConfig = Object.fromEntries(OUTCOMES.map((o, i) => [o, { label: t(`home.outcome.${o}`), color: SERIES[i] }]));
  const empty = data.every((w) => w.total === 0);
  const legend = (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-12 text-muted" data-testid="home-chart-legend">
      {OUTCOMES.map((o, i) => (
        <li key={o} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm" style={{ background: SERIES[i] }} />
          {t(`home.outcome.${o}`)}
        </li>
      ))}
    </ul>
  );
  return (
    <ChartPart title={t("home.chart.feedback")} legend={empty ? undefined : legend} testId="home-chart-feedback">
      {empty ? (
        <p className="py-8 text-13 text-subtle">{t("home.chart.feedbackNone")}</p>
      ) : (
        <div aria-hidden>
          <ChartContainer config={config} className="aspect-auto h-52 w-full" initialDimension={{ width: 480, height: 208 }}>
            <BarChart data={data} margin={MARGIN} accessibilityLayer={false}>
              <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
              <XAxis dataKey="label" tickLine={false} axisLine={AXIS} tick={TICK} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={TICK} width={40} />
              <Tooltip
                cursor={{ fill: "var(--bg-hover)" }}
                content={({ active, payload }) => {
                  const w = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
                  return w ? <TipBox lines={[t("home.chart.weekOf", { day: w.label }), ...OUTCOMES.map((o) => `${t(`home.outcome.${o}`)} ${w[o]}`)]} /> : null;
                }}
              />
              {OUTCOMES.map((o) => (
                <Bar key={o} dataKey={o} stackId="fb" fill={`var(--color-${o})`} isAnimationActive={false}>
                  {o === "open" ? <LabelList dataKey="total" position="top" {...VALUE} formatter={(v: unknown) => (Number(v) > 0 ? String(v) : "")} /> : null}
                </Bar>
              ))}
            </BarChart>
          </ChartContainer>
        </div>
      )}
      <ReaderTable
        caption={t("home.chart.feedback")}
        head={[t("home.chart.week"), ...OUTCOMES.map((o) => t(`home.outcome.${o}`))]}
        rows={data.map((w) => [w.label, w.fixed, w.declined, w.open])}
      />
    </ChartPart>
  );
}
