import { cellText, type InstantReading, type VisualBlockOf } from "@forge/contracts/visual-blocks";

/** One roadmap item: where it sits on the shared time axis, as fractions of the axis's span. */
export interface TimelineItem {
  label: string;
  /** The lane's stored value (a state's own token, which the block names in words and keeps in its tooltip). */
  lane: string | null;
  /** A planned span, or a point when it has a start and no end. */
  span: { from: number; to: number; fromText: string; toText: string | null } | null;
  /** A forecast range, from its p50 to its p85. */
  forecast: { p50: number; p85: number; p50Text: string; p85Text: string } | null;
}

export interface TimelineModel {
  /** The earliest and latest instant the data holds; the axis runs exactly between them. */
  min: number;
  max: number;
  minText: string;
  maxText: string;
  /** Items in lane order, then by the date they start. */
  items: TimelineItem[];
  /** Items the frame holds no date for: listed, not placed. */
  undated: string[];
  hasSpan: boolean;
  hasForecast: boolean;
}

const at = (cell: unknown): number | null => {
  if (typeof cell !== "string") return null;
  const t = Date.parse(cell);
  return Number.isNaN(t) ? null : t;
};

/** What a timeline block draws: each row's dates read from its frame and placed on one linear time axis. */
export function timelineModel(b: VisualBlockOf<"timeline">, reading?: InstantReading & { day?(iso: string): string }): TimelineModel {
  const field = (n: string | undefined) => (n === undefined ? undefined : b.frame.fields.find((f) => f.name === n));
  const labelF = field(b.label);
  const text = (name: string | undefined, row: Record<string, unknown>) => {
    const f = field(name);
    return f ? cellText(f, row[f.name] as never, reading) : "—";
  };
  const laneOf = (row: Record<string, unknown>) => {
    const f = field(b.lane);
    const cell = f ? row[f.name] : undefined;
    return f?.type === "status" && typeof cell === "string" && cell !== "" ? cell : text(b.lane, row);
  };
  const items: (TimelineItem & { key: number })[] = [];
  const undated: string[] = [];
  const values: number[] = [];
  for (const row of b.frame.rows) {
    const label = labelF ? cellText(labelF, row[labelF.name], reading) : "—";
    const start = b.start === undefined ? null : at(row[b.start]);
    const end = b.end === undefined ? null : at(row[b.end]);
    const p50 = b.p50 === undefined ? null : at(row[b.p50]);
    const p85 = b.p85 === undefined ? null : at(row[b.p85]);
    const span =
      start === null
        ? null
        : {
            from: start,
            to: end !== null && end >= start ? end : start,
            fromText: text(b.start, row),
            toText: end !== null && end >= start ? text(b.end, row) : null,
          };
    const forecast =
      p50 !== null && p85 !== null && p85 >= p50
        ? { p50, p85, p50Text: text(b.p50, row), p85Text: text(b.p85, row) }
        : null;
    if (!span && !forecast) {
      undated.push(label);
      continue;
    }
    if (span) values.push(span.from, span.to);
    if (forecast) values.push(forecast.p50, forecast.p85);
    items.push({
      label,
      lane: b.lane === undefined ? null : laneOf(row),
      span: span as never,
      forecast,
      key: span?.from ?? forecast?.p50 ?? 0,
    });
  }
  const lanes: string[] = [];
  for (const i of items) if (i.lane !== null && !lanes.includes(i.lane)) lanes.push(i.lane);
  items.sort((a, c) => lanes.indexOf(a.lane ?? "") - lanes.indexOf(c.lane ?? "") || a.key - c.key);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const day = (t: number) => (reading?.day ?? ((iso: string) => iso.slice(0, 10)))(new Date(t).toISOString());
  return {
    min,
    max,
    minText: values.length ? day(min) : "",
    maxText: values.length ? day(max) : "",
    items: items.map(({ key: _k, ...rest }) => rest),
    undated,
    hasSpan: items.some((i) => i.span !== null),
    hasForecast: items.some((i) => i.forecast !== null),
  };
}

/** A position as a share of the axis, 0 to 1; the one instant of a zero-width axis sits at the start. */
export const share = (m: Pick<TimelineModel, "min" | "max">, t: number): number =>
  m.max === m.min ? 0 : (t - m.min) / (m.max - m.min);
