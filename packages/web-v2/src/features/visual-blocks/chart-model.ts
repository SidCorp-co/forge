import type { ReportCell, ReportField } from "@forge/contracts/report-queries";
import { cellText, type InstantReading, type VisualBlockOf } from "@forge/contracts/visual-blocks";

/** One line or bar group of a chart: the words the legend gives it and the value at each x. */
interface ChartSeries {
  key: string;
  name: string;
  /** One entry per point, null where the frame holds no value. */
  values: (number | null)[];
}

interface ChartPoint {
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
interface ChartUnsupported {
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

type ChartBlock = VisualBlockOf<"chart">;
type Scale = ChartModel["scale"];

interface ChartFields {
  x: ReportField;
  yFields: ReportField[];
  seriesField: ReportField | undefined;
}

/** The fields a block names, found in its frame, every value field on one scale. */
function chartFields(b: ChartBlock): ChartFields | ChartUnsupported {
  const x = fieldOf(b, b.x);
  const ys = b.y.map((n) => fieldOf(b, n));
  if (!x || ys.some((y) => !y)) return { unsupported: "a field it names is not in the frame" };
  const yFields = ys as ReportField[];
  if (yFields.some((y) => unitOf(y) !== unitOf(yFields[0]))) {
    return { unsupported: "its value fields differ in kind or unit, so they cannot share one scale" };
  }
  const seriesField = b.series === undefined ? undefined : fieldOf(b, b.series);
  if (b.series !== undefined && !seriesField) return { unsupported: "its series field is not in the frame" };
  return { x, yFields, seriesField };
}

/** Where a row sits on the x axis: its time, its number, or its place in the rows. */
function placeOf(scale: Scale, raw: ReportCell | undefined, nth: number): number {
  if (scale === "time") return typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (scale === "linear") return num(raw) ?? Number.NaN;
  return nth;
}

interface PlacedRows {
  points: ChartPoint[];
  /** Per point, each series' value under `series\0field`. */
  cells: Map<string, number | null>[];
  /** The series names in the order they first appear. */
  names: string[];
}

/** Every row placed at its x, rows that share an x merged; a row with no x, or a value given twice, is the reason. */
function placeRows(b: ChartBlock, { x, yFields, seriesField }: ChartFields, scale: Scale, reading?: InstantReading): PlacedRows | ChartUnsupported {
  const placed: PlacedRows = { points: [], cells: [], names: [] };
  const order = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of b.frame.rows) {
    const raw = row[x.name];
    const label = cellText(x, raw, reading);
    const at = placeOf(scale, raw, placed.points.length);
    if (Number.isNaN(at)) return { unsupported: `a row has no ${x.label} to place it by` };
    const group = scale !== "category" ? `${at}` : seriesField === undefined ? `#${placed.points.length}` : `L${label}`;
    let index = order.get(group);
    if (index === undefined) {
      index = placed.points.length;
      order.set(group, index);
      placed.points.push({ label, at });
      placed.cells.push(new Map());
    }
    const sname = seriesField ? cellText(seriesField, row[seriesField.name], reading) : "";
    if (seriesField && !placed.names.includes(sname)) placed.names.push(sname);
    for (const y of yFields) {
      const key = `${sname}\u0000${y.name}`;
      const id = `${index}\u0000${key}`;
      if (seen.has(id)) return { unsupported: `${x.label} ${label} appears twice${sname ? ` for ${sname}` : ""}` };
      seen.add(id);
      placed.cells[index].set(key, num(row[y.name]));
    }
  }
  return placed;
}

/** One line or bar per series name and value field. */
function seriesOf({ yFields, seriesField }: ChartFields, { cells, names }: PlacedRows): ChartSeries[] {
  const series: ChartSeries[] = [];
  for (const sname of seriesField ? names : [""]) {
    for (const y of yFields) {
      const name = seriesField ? (yFields.length > 1 ? `${sname} · ${y.label}` : sname) : y.label;
      series.push({ key: `s${series.length}`, name, values: cells.map((m) => m.get(`${sname}\u0000${y.name}`) ?? null) });
    }
  }
  return series;
}

/**
 * What a chart block draws, read from its frame and nothing else: the x of each row, the numeric
 * cells of each y field, split by the series field where the block names one. A block whose rows
 * cannot be placed to scale comes back as the reason, not as a drawing.
 */
export function chartModel(b: ChartBlock, reading?: InstantReading): ChartModel | ChartUnsupported {
  const fields = chartFields(b);
  if ("unsupported" in fields) return fields;
  const { x, yFields } = fields;
  const yField = yFields[0];
  const numericX = b.variant !== "bar" && (x.type === "date" || x.type === "number" || x.type === "duration");
  const scale: Scale = !numericX ? "category" : x.type === "date" ? "time" : "linear";
  const placed = placeRows(b, fields, scale, reading);
  if ("unsupported" in placed) return placed;
  const { points } = placed;
  const series = seriesOf(fields, placed);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const { domain, ticks } = reached(all);
  const xs = [...new Set(points.map((p) => p.at))].sort((a, c) => a - c);
  const xTicks = scale === "category" ? null : xs.length <= 6 ? xs : [xs[0], xs[xs.length - 1]];
  const unit = yFields.every((y) => y.unit === yField.unit) ? yField.unit : undefined;
  const yLabel = yFields.length === 1 ? (unit ? `${yField.label} (${unit})` : yField.label) : unit ?? "";
  return { variant: b.variant, scale, points, series, xLabel: x.label, yLabel, yField, domain, yTicks: ticks, xTicks };
}
