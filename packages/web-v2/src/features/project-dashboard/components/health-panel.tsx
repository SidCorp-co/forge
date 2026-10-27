
// The project's health and its trend (REQ-24 BC-1): throughput, step failures, retries and
// interventions over a window the reader picks, one flat row on a hairline. Each figure is the
// window's total, its change on the window before as an arrow coloured by whether that change is
// good, and one bar per day under it; the window before's own figure and where each is read from
// sit behind the number and the label (BC-2: derived from existing records, no counter).

import { HEALTH_FIGURES, HEALTH_SOURCES, HEALTH_WINDOWS, type HealthDay, type HealthFigure, type HealthWindow } from "@forge/contracts/project-health";
import { Bar, BarChart } from "recharts";
import { type ChartConfig, ChartContainer, SegmentedControl, useUrlChoice } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useProjectHealth } from "../health-api";

/** One bar per day on the shared chart frame, scaled to the window's busiest day. */
function Bars({ series, figure }: { series: HealthDay[]; figure: HealthFigure }) {
  const config = { [figure]: { label: figure, color: figure === "throughput" ? "var(--accent-text)" : "var(--fg-muted)" } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="mt-2 aspect-auto h-16 w-full" aria-hidden="true">
      <BarChart data={series} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap="15%">
        <Bar dataKey={figure} fill={`var(--color-${figure})`} minPointSize={1} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}

/** Only throughput is better higher; every other figure counts something going wrong. */
const BETTER_HIGHER: Record<HealthFigure, boolean> = { throughput: true, stepFailures: false, retries: false, interventions: false };

/** The window's change on the window before: an arrow and a whole percent, green where it is better, red where worse. */
function Change({ now, before, figure }: { now: number; before: number; figure: HealthFigure }) {
  if (now === before) return <span className="font-mono text-12 text-subtle">=</span>;
  const up = now > before;
  const better = up === BETTER_HIGHER[figure];
  const pct = before === 0 ? null : Math.round((Math.abs(now - before) / before) * 100);
  return (
    <span className="font-mono text-12 font-semibold tabular-nums" style={{ color: better ? "var(--green-600)" : "var(--red-600)" }} data-testid={`health-${figure}-change`}>
      {up ? "\u25B2" : "\u25BC"}
      {pct === null ? "" : ` ${pct}%`}
    </span>
  );
}

/** The health window the URL names (`?window=`), 30 days where it names none. */
export function useHealthWindow() {
  const [span, setSpan] = useUrlChoice("window", HEALTH_WINDOWS.map(String), "30");
  return { span, setSpan, days: Number(span) as HealthWindow };
}

export function ProjectHealthFigures({ projectId }: { projectId: string }) {
  const t = useCopy();
  const { span, setSpan, days } = useHealthWindow();
  const q = useProjectHealth(projectId, days);
  return (
    <section aria-label={t("dash.health")} data-testid="project-health" className="border-y border-line-subtle py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-12 font-semibold text-subtle">{t("dash.health")}</h3>
        <SegmentedControl
          options={HEALTH_WINDOWS.map((d) => ({ value: String(d), label: t("dash.health.days", { n: d }) }))}
          value={span}
          onChange={setSpan}
        />
      </div>
      {q.isError ? (
        <p className="mt-2 text-13 text-muted">{formatApiError(q.error)}</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-4">
          {HEALTH_FIGURES.map((f) => (
            <div key={f} className="min-w-0" data-testid={`health-${f}`}>
              <span className="text-13 text-muted" title={HEALTH_SOURCES[f]}>
                {t(`dash.health.${f}` as ProductCopyKey)}
              </span>
              <div className="flex items-baseline gap-2" title={q.data ? t("dash.health.previous", { n: q.data.previous[f] }) : undefined}>
                <span className="font-mono text-24 font-semibold tabular-nums text-fg">{q.data ? q.data.totals[f] : "–"}</span>
                {q.data ? <Change now={q.data.totals[f]} before={q.data.previous[f]} figure={f} /> : null}
              </div>
              {q.data ? <Bars series={q.data.series} figure={f} /> : <div className="mt-2 h-16" />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
