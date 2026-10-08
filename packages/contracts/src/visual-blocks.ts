// The Block port: look by blocks. A block is plain data a message stores and a screen draws by its
// kind; six kinds exist, and each answers three things as pure functions registered in one table:
// `isSensible` (does this frame suit the kind), `check` (is this block valid, refused by name) and
// `toText` (the plain-text and Markdown fallback external doors, export and screen readers read).
// The web side keeps a renderer per kind under the same ids, and a parity test binds the two.
//
// A number reaches a block only from a run's frame. A block holds no figure of its own: its schema
// is strict, so a typed value is an unknown key and is refused.

import { z } from "zod";
import {
  type ReportCell,
  type ReportField,
  type ReportFieldType,
  type ReportFrame,
  ReportFrameSchema,
  stateLabel,
} from "./report-queries.js";

export const VISUAL_BLOCK_KINDS = [
  "table",
  "chart",
  "flow",
  "timeline",
  "kpi",
  "status-list",
] as const;
export type VisualBlockKind = (typeof VISUAL_BLOCK_KINDS)[number];

export const VISUAL_BLOCK_VERSION = 1;
export const FLOW_MAX_NODES = 60;
export const FLOW_MAX_EDGES = 200;
export const TABLE_MAX_ROWS = 500;
export const KPI_MIN_FIGURES = 2;
export const KPI_MAX_FIGURES = 6;
export const CHART_VARIANTS = ["bar", "line", "burndown"] as const;
export type ChartVariant = (typeof CHART_VARIANTS)[number];

const FIELD = z.string().min(1).max(64);
const TITLE = z.string().min(1).max(120);
const FLOW_ID = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const FLOW_LABEL = z.string().min(1).max(80);

/**
 * Where a block's frame came from: a stored run, or an execution whose frame is labelled computed.
 * An execution may answer several frames; `frame` is the index of the one drawn, and may be left
 * out only where the execution answered one.
 */
export const BlockSourceSchema = z.union([
  z.object({ runId: z.string().min(1) }).strict(),
  z.object({ executionId: z.string().min(1), frame: z.number().int().min(0).optional() }).strict(),
]);
export type BlockSource = z.infer<typeof BlockSourceSchema>;

export const TableSpecSchema = z
  .object({
    kind: z.literal("table"),
    title: TITLE.optional(),
    columns: z.array(FIELD).min(1).max(32),
    sort: z.object({ field: FIELD, dir: z.enum(["asc", "desc"]) }).strict().optional(),
    limit: z.number().int().min(1).max(TABLE_MAX_ROWS).optional(),
  })
  .strict();

export const ChartSpecSchema = z
  .object({
    kind: z.literal("chart"),
    title: TITLE.optional(),
    variant: z.enum(CHART_VARIANTS),
    x: FIELD,
    y: z.array(FIELD).min(1).max(6),
    series: FIELD.optional(),
  })
  .strict();

export const FlowSpecSchema = z
  .object({
    kind: z.literal("flow"),
    title: TITLE.optional(),
    nodes: z.array(z.object({ id: FLOW_ID, label: FLOW_LABEL }).strict()).min(1).max(FLOW_MAX_NODES),
    edges: z
      .array(z.object({ from: FLOW_ID, to: FLOW_ID, label: FLOW_LABEL.optional() }).strict())
      .max(FLOW_MAX_EDGES),
  })
  .strict();

export const TimelineSpecSchema = z
  .object({
    kind: z.literal("timeline"),
    title: TITLE.optional(),
    label: FIELD,
    start: FIELD.optional(),
    end: FIELD.optional(),
    p50: FIELD.optional(),
    p85: FIELD.optional(),
    lane: FIELD.optional(),
  })
  .strict();

export const KpiSpecSchema = z
  .object({
    kind: z.literal("kpi"),
    title: TITLE.optional(),
    row: z.number().int().min(0).optional(),
    figures: z
      .array(z.object({ field: FIELD, label: z.string().min(1).max(60), delta: FIELD.optional() }).strict())
      .min(KPI_MIN_FIGURES)
      .max(KPI_MAX_FIGURES),
  })
  .strict();

export const StatusListSpecSchema = z
  .object({
    kind: z.literal("status-list"),
    title: TITLE.optional(),
    ref: FIELD,
    status: FIELD,
    waitingOn: FIELD.optional(),
  })
  .strict();

/** What a block is, without where its data came from: what a template's layout and a stored block share. */
export const BlockSpecSchema = z.discriminatedUnion("kind", [
  TableSpecSchema,
  ChartSpecSchema,
  FlowSpecSchema,
  TimelineSpecSchema,
  KpiSpecSchema,
  StatusListSpecSchema,
]);
export type BlockSpec = z.infer<typeof BlockSpecSchema>;

const COMMON = { v: z.literal(VISUAL_BLOCK_VERSION) };
const FRAMED = { source: BlockSourceSchema, frame: ReportFrameSchema };

export const TableBlockSchema = TableSpecSchema.extend({ ...COMMON, ...FRAMED });
export const ChartBlockSchema = ChartSpecSchema.extend({ ...COMMON, ...FRAMED });
/** A flow block holds either a run's frame with its source, or neither: model-authored nodes carry no figures. */
export const FlowBlockSchema = FlowSpecSchema.extend({
  ...COMMON,
  source: BlockSourceSchema.optional(),
  frame: ReportFrameSchema.optional(),
});
export const TimelineBlockSchema = TimelineSpecSchema.extend({ ...COMMON, ...FRAMED });
export const KpiBlockSchema = KpiSpecSchema.extend({ ...COMMON, ...FRAMED });
export const StatusListBlockSchema = StatusListSpecSchema.extend({ ...COMMON, ...FRAMED });

export const VisualBlockSchema = z.discriminatedUnion("kind", [
  TableBlockSchema,
  ChartBlockSchema,
  FlowBlockSchema,
  TimelineBlockSchema,
  KpiBlockSchema,
  StatusListBlockSchema,
]);
export type VisualBlock = z.infer<typeof VisualBlockSchema>;
export type VisualBlockOf<K extends VisualBlockKind> = Extract<VisualBlock, { kind: K }>;

/** One reason a block was refused: the kind, the field that was wrong, and what is valid. */
export interface BlockRefusal {
  kind: string;
  field: string;
  message: string;
}
export type BlockCheck =
  | { ok: true; block: VisualBlock }
  | { ok: false; refusals: BlockRefusal[] };

/** The valid shape of each kind, quoted in every refusal of it. */
export const BLOCK_SHAPES: Record<VisualBlockKind, string> = {
  table:
    '{ v: 1, kind: "table", columns: [field, ...], sort?: { field, dir: "asc" | "desc" }, limit?: 1-500, title?, source: { runId } | { executionId, frame? }, frame }',
  chart:
    '{ v: 1, kind: "chart", variant: "bar" | "line" | "burndown", x: field, y: [numeric field, ...1-6], series?: field, title?, source: { runId } | { executionId, frame? }, frame }',
  flow: '{ v: 1, kind: "flow", nodes: [{ id, label }, ...1-60], edges: [{ from, to, label? }, ...], title?, source?: { runId } | { executionId, frame? }, frame? } with source and frame given together or not at all',
  timeline:
    '{ v: 1, kind: "timeline", label: field, start?: date field, end?: date field, p50?: date field, p85?: date field, lane?: field, title?, source: { runId } | { executionId, frame? }, frame } with a start, or a p50 and a p85',
  kpi: '{ v: 1, kind: "kpi", row?: index, figures: [{ field: numeric field, label, delta?: numeric field }, ...2-6], title?, source: { runId } | { executionId, frame? }, frame }',
  "status-list":
    '{ v: 1, kind: "status-list", ref: ref field, status: status field, waitingOn?: field, title?, source: { runId } | { executionId, frame? }, frame }',
};

/** A label is plain text: an angle bracket is refused so no label can carry markup. */
const MARKUP = /[<>]/;
const NUMERIC: readonly ReportFieldType[] = ["number", "duration"];
const NAMING: readonly ReportFieldType[] = ["string", "ref", "status"];

/** The part of a frame a block is judged against: its fields, and its rows where there are any to index. */
export interface FrameShape {
  fields: readonly ReportField[];
  rows?: readonly unknown[];
}

class Refusals {
  readonly list: BlockRefusal[] = [];
  constructor(private readonly kind: string) {}
  add(field: string, why: string): void {
    const shape = Object.hasOwn(BLOCK_SHAPES, this.kind) ? BLOCK_SHAPES[this.kind as VisualBlockKind] : "";
    this.list.push({
      kind: this.kind,
      field,
      message: `${this.kind} block: ${field}: ${why}${shape ? `; valid shape: ${shape}` : ""}`,
    });
  }
}

function fieldNamed(frame: FrameShape, name: string, at: string, out: Refusals): ReportField | null {
  const f = frame.fields.find((x) => x.name === name);
  if (!f) {
    out.add(at, `"${name}" is not a field of the frame; the frame has: ${frame.fields.map((x) => x.name).join(", ")}`);
    return null;
  }
  return f;
}

function fieldOfType(
  frame: FrameShape,
  name: string,
  at: string,
  types: readonly ReportFieldType[],
  out: Refusals,
): ReportField | null {
  const f = fieldNamed(frame, name, at, out);
  if (f && !types.includes(f.type)) {
    out.add(at, `"${name}" is ${f.type}, but this needs ${types.join(" or ")}`);
    return null;
  }
  return f;
}

const hasType = (frame: FrameShape, types: readonly ReportFieldType[], min = 1): boolean =>
  frame.fields.filter((f) => types.includes(f.type)).length >= min;

type Semantics<K extends VisualBlockKind> = (block: Omit<VisualBlockOf<K>, "v">, frame: FrameShape, out: Refusals) => void;

const semantics: { [K in VisualBlockKind]: Semantics<K> } = {
  table(b, frame, out) {
    const seen = new Set<string>();
    for (const [i, c] of b.columns.entries()) {
      if (seen.has(c)) out.add(`columns.${i}`, `"${c}" is listed twice`);
      seen.add(c);
      fieldNamed(frame, c, `columns.${i}`, out);
    }
    if (b.sort) fieldNamed(frame, b.sort.field, "sort.field", out);
  },
  chart(b, frame, out) {
    const x = fieldNamed(frame, b.x, "x", out);
    if (b.variant === "burndown" && x && x.type !== "date") {
      out.add("x", `a burndown is drawn over dates, but "${b.x}" is ${x.type}`);
    }
    for (const [i, y] of b.y.entries()) {
      if (y === b.x) out.add(`y.${i}`, `"${y}" is also the x field`);
      fieldOfType(frame, y, `y.${i}`, NUMERIC, out);
    }
    if (b.series !== undefined) {
      fieldNamed(frame, b.series, "series", out);
      if (b.series === b.x) out.add("series", `"${b.series}" is also the x field`);
    }
  },
  flow(b, _frame, out) {
    const ids = new Set<string>();
    for (const [i, n] of b.nodes.entries()) {
      if (ids.has(n.id)) out.add(`nodes.${i}.id`, `node id "${n.id}" is used twice`);
      ids.add(n.id);
      if (MARKUP.test(n.label)) out.add(`nodes.${i}.label`, "a label is plain text; it holds no markup");
    }
    for (const [i, e] of b.edges.entries()) {
      if (!ids.has(e.from)) out.add(`edges.${i}.from`, `"${e.from}" is not a node id; nodes: ${[...ids].join(", ")}`);
      if (!ids.has(e.to)) out.add(`edges.${i}.to`, `"${e.to}" is not a node id; nodes: ${[...ids].join(", ")}`);
      if (e.label !== undefined && MARKUP.test(e.label)) {
        out.add(`edges.${i}.label`, "a label is plain text; it holds no markup");
      }
    }
  },
  timeline(b, frame, out) {
    fieldOfType(frame, b.label, "label", NAMING, out);
    for (const key of ["start", "end", "p50", "p85"] as const) {
      const name = b[key];
      if (name !== undefined) fieldOfType(frame, name, key, ["date"], out);
    }
    if (b.start === undefined && b.p50 === undefined) {
      out.add("start", "a timeline item needs a start, or a p50 and a p85 range");
    }
    if (b.end !== undefined && b.start === undefined) out.add("end", "an end needs a start");
    if ((b.p50 === undefined) !== (b.p85 === undefined)) {
      out.add(b.p50 === undefined ? "p50" : "p85", "a forecast range needs both p50 and p85");
    }
    if (b.lane !== undefined) fieldNamed(frame, b.lane, "lane", out);
  },
  kpi(b, frame, out) {
    const seen = new Set<string>();
    for (const [i, fig] of b.figures.entries()) {
      if (seen.has(fig.field)) out.add(`figures.${i}.field`, `"${fig.field}" is shown twice`);
      seen.add(fig.field);
      fieldOfType(frame, fig.field, `figures.${i}.field`, NUMERIC, out);
      if (fig.delta !== undefined) fieldOfType(frame, fig.delta, `figures.${i}.delta`, NUMERIC, out);
    }
    const row = b.row ?? 0;
    if (frame.rows && frame.rows[row] === undefined) {
      out.add("row", `row ${row} does not exist; the frame has ${frame.rows.length} row(s)`);
    }
  },
  "status-list"(b, frame, out) {
    fieldOfType(frame, b.ref, "ref", ["ref"], out);
    fieldOfType(frame, b.status, "status", ["status"], out);
    if (b.waitingOn !== undefined) fieldOfType(frame, b.waitingOn, "waitingOn", NAMING, out);
  },
};

const sensible: Record<VisualBlockKind, (frame: FrameShape) => boolean> = {
  table: (f) => f.fields.length >= 1,
  chart: (f) => hasType(f, NUMERIC) && f.fields.length >= 2,
  flow: (f) => hasType(f, ["status"]) && hasType(f, ["string", "ref"]),
  timeline: (f) => hasType(f, ["date"]) && hasType(f, NAMING),
  kpi: (f) => hasType(f, NUMERIC, KPI_MIN_FIGURES),
  "status-list": (f) => hasType(f, ["ref"]) && hasType(f, ["status"]),
};

const NEEDS: Record<VisualBlockKind, string> = {
  table: "at least one field",
  chart: "a numeric field and a field to put on the x axis",
  flow: "a status field and a string or ref field naming each step",
  timeline: "a date field and a field naming each item",
  kpi: `at least ${KPI_MIN_FIGURES} numeric fields`,
  "status-list": "a ref field and a status field",
};

function zodRefusals(error: z.ZodError, out: Refusals): void {
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      out.add(
        issue.keys.join(", "),
        `unknown key; a block holds no figure of its own, and a number reaches it only from the frame of the run it names`,
      );
      continue;
    }
    const field = issue.path.length > 0 ? issue.path.join(".") : "(block)";
    out.add(field, issue.message);
  }
}

function entry<K extends VisualBlockKind>(
  kind: K,
  schema: z.ZodType<VisualBlockOf<K>>,
  toText: (block: VisualBlockOf<K>, reading?: InstantReading) => string,
): BlockKindEntry<K> {
  return {
    kind,
    shape: BLOCK_SHAPES[kind],
    schema,
    isSensible: sensible[kind],
    check(raw: unknown): BlockCheck {
      const out = new Refusals(kind);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        zodRefusals(parsed.error, out);
        return { ok: false, refusals: out.list };
      }
      const block = parsed.data;
      const frame: FrameShape | undefined = block.frame;
      if (kind === "flow") {
        if ((block.source === undefined) !== (block.frame === undefined)) {
          out.add(
            block.source === undefined ? "source" : "frame",
            "source and frame are given together or not at all",
          );
        }
      }
      semantics[kind](block as never, frame ?? { fields: [] }, out);
      if (frame && !sensible[kind](frame)) {
        out.add("frame", `the frame does not suit a ${kind}; it needs ${NEEDS[kind]}`);
      }
      return out.list.length > 0 ? { ok: false, refusals: out.list } : { ok: true, block };
    },
    toText,
  };
}

export interface BlockKindEntry<K extends VisualBlockKind = VisualBlockKind> {
  kind: K;
  /** The valid shape, as quoted in a refusal. */
  shape: string;
  schema: z.ZodType<VisualBlockOf<K>>;
  /** Does this frame suit the kind, judged on its fields alone. */
  isSensible(frame: FrameShape): boolean;
  /** Is this block valid; a refusal names the kind, the field and the valid shape. */
  check(raw: unknown): BlockCheck;
  /** The plain-text and Markdown fallback. */
  toText(block: VisualBlockOf<K>, reading?: InstantReading): string;
}

// ---- text fallback --------------------------------------------------------------------------

function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const parts: string[] = [];
  let s = Math.floor(ms / 1000);
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    const n = Math.floor(s / size);
    if (n > 0) parts.push(`${n}${unit}`);
    s -= n * size;
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/**
 * How a screen reads an instant: the viewer's own words and timezone. The contract cannot know
 * either, so a reading is handed in by whoever draws the text: a screen its viewer's clock, a
 * server-made text (`UTC_READING`) UTC. Without one an instant keeps its ISO form.
 */
export interface InstantReading {
  /** An ISO instant or date inside a cell, as a person reads it. */
  instant(iso: string): string;
}

const UTC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A bare calendar day, or midnight UTC: a day with no time of its own, which no timezone moves. */
const UTC_DAY_ONLY = /^\d{4}-\d{2}-\d{2}(?:T00:00(?::00(?:\.0+)?)?Z)?$/;

/**
 * The reading of a text no viewer is behind (a report's Markdown export, a CSV, the run text a
 * stored report keeps): every instant in UTC and says so, "Oct 4, 18:19 UTC", a calendar day as
 * "Oct 4". An instant that is not one stays as it was written.
 */
export const UTC_READING: InstantReading = {
  instant(iso) {
    const day = (at: Date) => `${UTC_MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
    if (UTC_DAY_ONLY.test(iso)) {
      const at = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
      return Number.isNaN(at.getTime()) ? iso : day(at);
    }
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    const clock = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
    return `${day(at)}, ${clock} UTC`;
  },
};

/** An ISO-8601 instant or calendar date, wherever it stands inside a sentence. */
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

/** Every ISO instant in a text, each read as the screen reads it; the rest of the text is untouched. */
export function readInstantsIn(text: string, reading: InstantReading | undefined): string {
  return reading ? text.replace(ISO_INSTANT, (iso) => reading.instant(iso)) : text;
}

/**
 * One cell as text: null is an em dash, a duration is spoken, a date is read by the screen's
 * `reading` (without one a midnight date loses its time and any other keeps its ISO form), a
 * sentence that names an instant has it read the same way, and a state reads as its sentence-case
 * label (`stateLabel`), the words its badge shows.
 */
export function cellText(field: ReportField, cell: ReportCell | undefined, reading?: InstantReading): string {
  if (cell === null || cell === undefined) return "—";
  if (field.type === "status" && typeof cell === "string" && cell !== "") return stateLabel(field, cell);
  if (field.type === "duration" && typeof cell === "number") return duration(cell);
  if (field.type === "date" && typeof cell === "string") return reading ? readInstantsIn(cell, reading) : cell.replace(/T00:00:00(\.0+)?Z$/, "");
  if (field.type === "string" && typeof cell === "string") return readInstantsIn(cell, reading);
  if (typeof cell === "number") return field.unit ? `${cell} ${field.unit}` : String(cell);
  return cell;
}

const md = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function titled(block: { title?: string | undefined }, body: string): string {
  return block.title === undefined ? body : `**${md(block.title)}**\n\n${body}`;
}

function markdownTable(frame: ReportFrame, columns: readonly string[], rows = frame.rows, reading?: InstantReading): string {
  const fields = columns.map((c) => frame.fields.find((f) => f.name === c)).filter((f): f is ReportField => !!f);
  const head = `| ${fields.map((f) => md(f.label)).join(" | ")} |`;
  const rule = `| ${fields.map((f) => (NUMERIC.includes(f.type) ? "---:" : "---")).join(" | ")} |`;
  const body = rows.map((r) => `| ${fields.map((f) => md(cellText(f, r[f.name], reading))).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

function compare(a: ReportCell | undefined, b: ReportCell | undefined): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function sorted(rows: ReportFrame["rows"], field: string, dir: "asc" | "desc"): ReportFrame["rows"] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = x[field];
    const b = y[field];
    if (a === null || a === undefined || b === null || b === undefined) return compare(a, b);
    return sign * compare(a, b);
  });
}

/** The rows a table block shows: the frame's rows sorted as the block says, then cut to its limit. */
export function tableRows(b: VisualBlockOf<"table">): ReportFrame["rows"] {
  const rows = b.sort ? sorted(b.frame.rows, b.sort.field, b.sort.dir) : b.frame.rows;
  return b.limit === undefined ? rows : rows.slice(0, b.limit);
}

function tableText(b: VisualBlockOf<"table">, reading?: InstantReading): string {
  return titled(b, markdownTable(b.frame, b.columns, tableRows(b), reading));
}

/** A cell a spreadsheet would run as a formula; it is written with a leading apostrophe so it reads as text. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV field per RFC 4180: quoted when it holds a quote, a comma or a line break, its quotes doubled. */
function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvCell(field: ReportField, cell: ReportCell | undefined, reading?: InstantReading): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return field.type === "duration" ? cellText(field, cell) : String(cell);
  const text = cellText(field, cell, reading);
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

/** A column's CSV heading: its label, with its unit where it has one, since a number cell carries none. */
const csvHeading = (f: ReportField): string => (f.unit && f.type === "number" ? `${f.label} (${f.unit})` : f.label);

/** The UTF-8 byte order mark a CSV opens with, so a spreadsheet reads Vietnamese and other non-ASCII text as UTF-8. */
export const CSV_BOM = "\uFEFF";

/**
 * A table block as CSV (RFC 4180, CRLF line ends), opening with the UTF-8 byte order mark: a heading
 * row of the column labels, then the rows the table shows, sorted and cut as the block says. A cell
 * reads as the table reads it (a state as its label, a duration spoken), except that an empty cell is
 * empty and a number is bare, its unit in the heading. A text cell a spreadsheet would run as a
 * formula opens with an apostrophe. A date reads as `reading` reads it; a server export hands
 * `UTC_READING`, so no cell carries raw ISO.
 */
export function tableCsv(b: VisualBlockOf<"table">, reading?: InstantReading): string {
  const fields = b.columns.flatMap((c) => b.frame.fields.filter((f) => f.name === c));
  const lines = [
    fields.map((f) => csvField(csvHeading(f))).join(","),
    ...tableRows(b).map((row) => fields.map((f) => csvField(csvCell(f, row[f.name], reading))).join(",")),
  ];
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

function chartText(b: VisualBlockOf<"chart">, reading?: InstantReading): string {
  const columns = [b.x, ...(b.series ? [b.series] : []), ...b.y];
  const label = (name: string) => b.frame.fields.find((f) => f.name === name)?.label ?? name;
  const what = `${b.variant === "burndown" ? "Burndown" : b.variant === "line" ? "Line chart" : "Bar chart"} of ${b.y
    .map(label)
    .join(", ")} by ${label(b.x)}`;
  return titled(b, `${what}\n\n${markdownTable(b.frame, columns, b.frame.rows, reading)}`);
}

function flowText(b: VisualBlockOf<"flow">): string {
  const name = new Map(b.nodes.map((n) => [n.id, n.label]));
  const linked = new Set(b.edges.flatMap((e) => [e.from, e.to]));
  const lines = b.edges.map(
    (e) => `- ${md(name.get(e.from) ?? e.from)} -> ${md(name.get(e.to) ?? e.to)}${e.label ? ` (${md(e.label)})` : ""}`,
  );
  const alone = b.nodes.filter((n) => !linked.has(n.id)).map((n) => `- ${md(n.label)}`);
  return titled(b, [...lines, ...alone].join("\n"));
}

function timelineText(b: VisualBlockOf<"timeline">, reading?: InstantReading): string {
  const f = (name: string) => b.frame.fields.find((x) => x.name === name);
  const at = (row: ReportFrame["rows"][number], name: string | undefined) => {
    const field = name === undefined ? undefined : f(name);
    return field ? cellText(field, row[field.name], reading) : "—";
  };
  const key = b.start ?? b.p50;
  const rows = key ? sorted(b.frame.rows, key, "asc") : b.frame.rows;
  const lines = rows.map((r) => {
    const lane = b.lane ? ` [${md(at(r, b.lane))}]` : "";
    const when =
      b.start !== undefined
        ? `${at(r, b.start)}${b.end !== undefined ? ` to ${at(r, b.end)}` : ""}`
        : `p50 ${at(r, b.p50)}, p85 ${at(r, b.p85)}`;
    return `- ${md(at(r, b.label))}${lane}: ${when}`;
  });
  return titled(b, lines.join("\n"));
}

/** One figure of a kpi block as it is shown: its label, its value as text, and its signed delta where it has one. */
export interface KpiFigure {
  label: string;
  value: string;
  delta?: string;
}

/** The figures a kpi block shows, read from the one row it names. */
export function kpiFigures(b: VisualBlockOf<"kpi">, reading?: InstantReading): KpiFigure[] {
  const row = b.frame.rows[b.row ?? 0];
  return b.figures.map((fig) => {
    const field = b.frame.fields.find((x) => x.name === fig.field);
    const dfield = fig.delta === undefined ? undefined : b.frame.fields.find((x) => x.name === fig.delta);
    const out: KpiFigure = { label: fig.label, value: field && row ? cellText(field, row[field.name], reading) : "—" };
    if (dfield && row) {
      const raw = row[dfield.name];
      out.delta = `${typeof raw === "number" && raw > 0 ? "+" : ""}${cellText(dfield, raw, reading)}`;
    }
    return out;
  });
}

function kpiText(b: VisualBlockOf<"kpi">, reading?: InstantReading): string {
  const lines = kpiFigures(b, reading).map((f) => `- ${md(f.label)}: ${md(f.value)}${f.delta === undefined ? "" : ` (${f.delta})`}`);
  return titled(b, lines.join("\n"));
}

function statusListText(b: VisualBlockOf<"status-list">, reading?: InstantReading): string {
  const lines = b.frame.rows.map((r) => {
    const get = (name: string | undefined) => {
      const field = name === undefined ? undefined : b.frame.fields.find((x) => x.name === name);
      return field ? cellText(field, r[field.name], reading) : "—";
    };
    const waiting = b.waitingOn !== undefined && r[b.waitingOn] != null ? ` (waiting on ${md(get(b.waitingOn))})` : "";
    return `- ${md(get(b.ref))}: ${md(get(b.status))}${waiting}`;
  });
  return titled(b, lines.join("\n"));
}

/** The one table: a kind is added by adding its entry here and its renderer in web, together. */
export const BLOCK_KINDS: { [K in VisualBlockKind]: BlockKindEntry<K> } = {
  table: entry("table", TableBlockSchema, tableText),
  chart: entry("chart", ChartBlockSchema, chartText),
  flow: entry("flow", FlowBlockSchema, flowText),
  timeline: entry("timeline", TimelineBlockSchema, timelineText),
  kpi: entry("kpi", KpiBlockSchema, kpiText),
  "status-list": entry("status-list", StatusListBlockSchema, statusListText),
};

export const isVisualBlockKind = (kind: unknown): kind is VisualBlockKind =>
  typeof kind === "string" && Object.hasOwn(BLOCK_KINDS, kind);

/** Does this frame suit a block of `kind`. */
export function isSensible(kind: VisualBlockKind, frame: FrameShape): boolean {
  return BLOCK_KINDS[kind].isSensible(frame);
}

/**
 * Checks a stored or proposed block of any kind. A block with no kind, or a kind that is not
 * registered, is refused naming the kind and the kinds that exist: it is never dropped.
 */
export function checkBlock(raw: unknown): BlockCheck {
  const kind = raw !== null && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  if (kind === undefined) {
    const out = new Refusals("(none)");
    out.add("kind", `a block names its kind; registered kinds: ${VISUAL_BLOCK_KINDS.join(", ")}`);
    return { ok: false, refusals: out.list };
  }
  if (!isVisualBlockKind(kind)) {
    const named = typeof kind === "string" ? kind : JSON.stringify(kind);
    const out = new Refusals(named);
    out.add("kind", `unknown block kind "${named}"; registered kinds: ${VISUAL_BLOCK_KINDS.join(", ")}`);
    return { ok: false, refusals: out.list };
  }
  return BLOCK_KINDS[kind].check(raw);
}

/** Checks every block of a message; each one answers, and none is skipped. */
export function checkBlocks(raws: readonly unknown[]): BlockCheck[] {
  return raws.map(checkBlock);
}

/** The fields of its frame a framed block puts in front of its reader, in the order it names them. */
function shownFields(block: VisualBlock): string[] {
  switch (block.kind) {
    case "table":
      return block.columns;
    case "chart":
      return [block.x, ...(block.series ? [block.series] : []), ...block.y];
    case "kpi":
      return block.figures.flatMap((f) => [f.field, ...(f.delta === undefined ? [] : [f.delta])]);
    case "status-list":
      return [block.ref, block.status, ...(block.waitingOn === undefined ? [] : [block.waitingOn])];
    case "timeline":
      return [block.label, block.start, block.end, block.p50, block.p85, block.lane].filter(
        (f): f is string => f !== undefined,
      );
    case "flow":
      return [];
  }
}

/**
 * What a block shows of its frame: the fields it draws, over the rows it draws (a table's sorted and
 * cut to its limit, the one row a kpi reads). A figure the reader can check against the block is one
 * of these cells, or the count of its rows. A flow shows its own labels and no frame, so it answers
 * null, as does a block with no frame.
 */
export function shownFrame(block: VisualBlock): ReportFrame | null {
  if (block.kind === "flow" || !block.frame) return null;
  const names = new Set(shownFields(block));
  const fields = block.frame.fields.filter((f) => names.has(f.name));
  const rows =
    block.kind === "table"
      ? tableRows(block)
      : block.kind === "kpi"
        ? block.frame.rows.slice(block.row ?? 0, (block.row ?? 0) + 1)
        : block.frame.rows;
  return {
    fields,
    rows: rows.map((r) => Object.fromEntries(fields.map((f) => [f.name, r[f.name] ?? null]))),
  };
}

/** The plain-text fallback of a block that passed `checkBlock`; whoever draws it passes a `reading` (a screen its viewer's, a server `UTC_READING`) so no instant stays ISO. */
export function blockToText(block: VisualBlock, reading?: InstantReading): string {
  return (BLOCK_KINDS[block.kind] as BlockKindEntry<typeof block.kind>).toText(block as never, reading);
}

/**
 * Checks a layout entry (a block spec with no data yet) against the fields of the frame it will
 * draw, as a template validator does before any query runs.
 */
export function checkBlockSpec(raw: unknown, frame: FrameShape): BlockRefusal[] {
  const kind = raw !== null && typeof raw === "object" ? (raw as { kind?: unknown }).kind : undefined;
  if (!isVisualBlockKind(kind)) {
    const named = typeof kind === "string" ? kind : JSON.stringify(kind);
    const out = new Refusals(String(named));
    out.add("kind", `unknown block kind "${named}"; registered kinds: ${VISUAL_BLOCK_KINDS.join(", ")}`);
    return out.list;
  }
  const out = new Refusals(kind);
  const parsed = BlockSpecSchema.safeParse(raw);
  if (!parsed.success) {
    zodRefusals(parsed.error, out);
    return out.list;
  }
  semantics[kind](parsed.data as never, frame, out);
  if (kind !== "flow" && !sensible[kind](frame)) {
    out.add("frame", `the frame does not suit a ${kind}; it needs ${NEEDS[kind]}`);
  }
  return out.list;
}
