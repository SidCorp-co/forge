import type { ReportCell, ReportField } from "@forge/contracts/report-queries";
import { cellText, type VisualBlockOf } from "@forge/contracts/visual-blocks";

/** One line or bar group of a chart: the words the legend gives it and the value at each x. */
export interface ChartSeries {
  key: string;
  name: string;
  /** One entry per point, null where the frame holds no value. */
  values: (number | null)[];
}

export interface ChartPoint {
  /** The x cell as it is read. */
  label: string;
  /** The x position when the axis is numeric or a time, else the point's index. */
  at: number;
}

export interface ChartModel {
  variant: "bar" | "line" | "burndown";
  /** `category` for bars, `time` for a date x, `linear` for a numeric x on a line. */
  scale: "category" | "time" | "linear";
  points: ChartPoint[];
  series: ChartSeries[];
  xLabel: string;
  yLabel: string;
  /** The y field every series is read as, so a tick reads as its cell does. */
  yField: ReportField;
  /** Exactly the span the data reaches, widened to include zero. */
  domain: [number, number];
  /** Axis marks at values the data reaches: zero, the lowest and the highest. */
  yTicks: number[];
  xTicks: number[] | null;
}

/** What a chart cannot say is not drawn; this is the reason, given in the reader's words. */
export interface ChartUnsupported {
  unsupported: string;
}

const fieldOf = (b: VisualBlockOf<"chart">, name: string): ReportField | undefined =>
  b.frame.fields.find((f) => f.name === name);

const num = (c: ReportCell | undefined): number | null => (typeof c === "number" && Number.isFinite(c) ? c : null);

const unitOf = (f: ReportField): string => `${f.type}|${f.unit ?? ""}`;

/** Marks at the values the data reaches, never at rounded numbers it does not. */
function reached(values: readonly number[]): { domain: [number, number]; ticks: number[] } {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (lo === hi) return { domain: [0, 1], ticks: [0] };
  return { domain: [lo, hi], ticks: [...new Set([lo, 0, hi])].sort((a, b) => a - b) };
}

/**
 * What a chart block draws, read from its frame and nothing else: the x of each row, the numeric
 * cells of each y field, split by the series field where the block names one. A block whose rows
 * cannot be placed to scale comes back as the reason, not as a drawing.
 */
export function chartModel(b: VisualBlockOf<"chart">): ChartModel | ChartUnsupported {
  const x = fieldOf(b, b.x);
  const ys = b.y.map((n) => fieldOf(b, n));
  if (!x || ys.some((y) => !y)) return { unsupported: "a field it names is not in the frame" };
  const yFields = ys as ReportField[];
  const yField = yFields[0] as ReportField;
  if (yFields.some((y) => unitOf(y) !== unitOf(yField))) {
    return { unsupported: "its value fields differ in kind or unit, so they cannot share one scale" };
  }
  const seriesField = b.series === undefined ? undefined : fieldOf(b, b.series);
  if (b.series !== undefined && !seriesField) return { unsupported: "its series field is not in the frame" };

  const numericX = b.variant !== "bar" && (x.type === "date" || x.type === "number" || x.type === "duration");
  const scale: ChartModel["scale"] = !numericX ? "category" : x.type === "date" ? "time" : "linear";

  const names: string[] = [];
  const order = new Map<string, number>();
  const points: ChartPoint[] = [];
  const cells: Map<string, number | null>[] = [];
  const seen = new Set<string>();
  for (const row of b.frame.rows) {
    const raw = row[x.name];
    const label = cellText(x, raw);
    const at = scale === "time" ? (typeof raw === "string" ? Date.parse(raw) : Number.NaN) : scale === "linear" ? (num(raw) ?? Number.NaN) : points.length;
    if (Number.isNaN(at)) return { unsupported: `a row has no ${x.label} to place it by` };
    const group = scale !== "category" ? `${at}` : seriesField === undefined ? `#${points.length}` : `L${label}`;
    let index = order.get(group);
    if (index === undefined) {
      index = points.length;
      order.set(group, index);
      points.push({ label, at });
      cells.push(new Map());
    }
    const sname = seriesField ? cellText(seriesField, row[seriesField.name]) : "";
    if (seriesField && !names.includes(sname)) names.push(sname);
    for (const y of yFields) {
      const key = `${sname}\u0000${y.name}`;
      const id = `${index}\u0000${key}`;
      if (seen.has(id)) return { unsupported: `${x.label} ${label} appears twice${sname ? ` for ${sname}` : ""}` };
      seen.add(id);
      (cells[index] as Map<string, number | null>).set(key, num(row[y.name]));
    }
  }

  const series: ChartSeries[] = [];
  for (const sname of seriesField ? names : [""]) {
    for (const y of yFields) {
      const name = seriesField ? (yFields.length > 1 ? `${sname} · ${y.label}` : sname) : y.label;
      series.push({
        key: `s${series.length}`,
        name,
        values: cells.map((m) => m.get(`${sname}\u0000${y.name}`) ?? null),
      });
    }
  }
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const { domain, ticks } = reached(all);
  const xs = [...new Set(points.map((p) => p.at))].sort((a, c) => a - c);
  const xTicks = scale === "category" ? null : xs.length <= 6 ? xs : [xs[0] as number, xs[xs.length - 1] as number];
  const unit = yFields.every((y) => y.unit === yField.unit) ? yField.unit : undefined;
  const yLabel = yFields.length === 1 ? (unit ? `${yField.label} (${unit})` : yField.label) : unit ?? "";
  return { variant: b.variant, scale, points, series, xLabel: x.label, yLabel, yField, domain, yTicks: ticks, xTicks };
}
