import { cellText, type InstantReading, type VisualBlockOf } from "@forge/contracts/visual-blocks";

/** One roadmap item: where it sits on the shared time axis, as fractions of the axis's span. */
export interface TimelineItem {
  /** The row of the frame it was read from: its identity, since two items may share a label. */
  row: number;
  label: string;
  /** The lane's stored value (a state's own token, which the block names in words and keeps in its tooltip). */
  lane: string | null;
  /** A planned span, or a point when it has a start and no end. */
  span: { from: number; to: number; fromText: string; toText: string | null } | null;
  /** A forecast range, from its p50 to its p85. */
  forecast: { p50: number; p85: number; p50Text: string; p85Text: string } | null;
}

interface TimelineModel {
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

type Row = Record<string, unknown>;
type Reading = InstantReading & { day?(iso: string): string };

/** How one block reads a row: a named field's cell as an instant, as words, and as a lane. */
function rowReader(b: VisualBlockOf<"timeline">, reading: Reading | undefined) {
  const field = (n: string | undefined) => (n === undefined ? undefined : b.frame.fields.find((f) => f.name === n));
  const text = (name: string | undefined, row: Row) => {
    const f = field(name);
    return f ? cellText(f, row[f.name] as never, reading) : "—";
  };
  const instant = (name: string | undefined, row: Row) => (name === undefined ? null : at(row[name]));
  const lane = (row: Row) => {
    const f = field(b.lane);
    const cell = f ? row[f.name] : undefined;
    return f?.type === "status" && typeof cell === "string" && cell !== "" ? cell : text(b.lane, row);
  };
  return { text, instant, lane };
}

/** A row's planned span: a point when it has a start and no end, or an end before its start. */
function spanOf(b: VisualBlockOf<"timeline">, row: Row, read: ReturnType<typeof rowReader>): TimelineItem["span"] {
  const start = read.instant(b.start, row);
  if (start === null) return null;
  const end = read.instant(b.end, row);
  const ends = end !== null && end >= start;
  return { from: start, to: ends ? end : start, fromText: read.text(b.start, row), toText: ends ? read.text(b.end, row) : null };
}

/** A row's forecast range, from its p50 to its p85, when both read and run forward. */
function forecastOf(b: VisualBlockOf<"timeline">, row: Row, read: ReturnType<typeof rowReader>): TimelineItem["forecast"] {
  const p50 = read.instant(b.p50, row);
  const p85 = read.instant(b.p85, row);
  return p50 !== null && p85 !== null && p85 >= p50 ? { p50, p85, p50Text: read.text(b.p50, row), p85Text: read.text(b.p85, row) } : null;
}

/** What a timeline block draws: each row's dates read from its frame and placed on one linear time axis. */
export function timelineModel(b: VisualBlockOf<"timeline">, reading?: Reading): TimelineModel {
  const read = rowReader(b, reading);
  const items: TimelineItem[] = [];
  const undated: string[] = [];
  for (const [rowAt, row] of b.frame.rows.entries()) {
    const label = b.label === undefined ? "—" : read.text(b.label, row);
    const span = spanOf(b, row, read);
    const forecast = forecastOf(b, row, read);
    if (span || forecast) items.push({ row: rowAt, label, lane: b.lane === undefined ? null : read.lane(row), span, forecast });
    else undated.push(label);
  }
  const values = items.flatMap((i) => [...(i.span ? [i.span.from, i.span.to] : []), ...(i.forecast ? [i.forecast.p50, i.forecast.p85] : [])]);
  const lanes = [...new Set(items.flatMap((i) => (i.lane === null ? [] : [i.lane])))];
  const startOf = (i: TimelineItem) => i.span?.from ?? i.forecast?.p50 ?? 0;
  items.sort((a, c) => lanes.indexOf(a.lane ?? "") - lanes.indexOf(c.lane ?? "") || startOf(a) - startOf(c));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const day = (t: number) => (reading?.day ?? ((iso: string) => iso.slice(0, 10)))(new Date(t).toISOString());
  return {
    min,
    max,
    minText: values.length ? day(min) : "",
    maxText: values.length ? day(max) : "",
    items,
    undated,
    hasSpan: items.some((i) => i.span !== null),
    hasForecast: items.some((i) => i.forecast !== null),
  };
}

/** A position as a share of the axis, 0 to 1; the one instant of a zero-width axis sits at the start. */
export const share = (m: Pick<TimelineModel, "min" | "max">, t: number): number =>
  m.max === m.min ? 0 : (t - m.min) / (m.max - m.min);
