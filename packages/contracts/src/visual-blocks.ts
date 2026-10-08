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

/** Where a block's frame came from: a stored run, or an execution whose frame is labelled computed. */
export const BlockSourceSchema = z.union([
  z.object({ runId: z.string().min(1) }).strict(),
  z.object({ executionId: z.string().min(1) }).strict(),
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
    '{ v: 1, kind: "table", columns: [field, ...], sort?: { field, dir: "asc" | "desc" }, limit?: 1-500, title?, source: { runId }, frame }',
  chart:
    '{ v: 1, kind: "chart", variant: "bar" | "line" | "burndown", x: field, y: [numeric field, ...1-6], series?: field, title?, source: { runId }, frame }',
  flow: '{ v: 1, kind: "flow", nodes: [{ id, label }, ...1-60], edges: [{ from, to, label? }, ...], title?, source?: { runId }, frame? } with source and frame given together or not at all',
  timeline:
    '{ v: 1, kind: "timeline", label: field, start?: date field, end?: date field, p50?: date field, p85?: date field, lane?: field, title?, source: { runId }, frame } with a start, or a p50 and a p85',
  kpi: '{ v: 1, kind: "kpi", row?: index, figures: [{ field: numeric field, label, delta?: numeric field }, ...2-6], title?, source: { runId }, frame }',
  "status-list":
    '{ v: 1, kind: "status-list", ref: ref field, status: status field, waitingOn?: field, title?, source: { runId }, frame }',
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
  toText: (block: VisualBlockOf<K>) => string,
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
  toText(block: VisualBlockOf<K>): string;
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

/** One cell as text: null is an em dash, a duration is spoken, a midnight date loses its time. */
export function cellText(field: ReportField, cell: ReportCell | undefined): string {
  if (cell === null || cell === undefined) return "—";
  if (field.type === "duration" && typeof cell === "number") return duration(cell);
  if (field.type === "date" && typeof cell === "string") return cell.replace(/T00:00:00(\.0+)?Z$/, "");
  if (typeof cell === "number") return field.unit ? `${cell} ${field.unit}` : String(cell);
  return cell;
}

const md = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function titled(block: { title?: string | undefined }, body: string): string {
  return block.title === undefined ? body : `**${md(block.title)}**\n\n${body}`;
}

function markdownTable(frame: ReportFrame, columns: readonly string[], rows = frame.rows): string {
  const fields = columns.map((c) => frame.fields.find((f) => f.name === c)).filter((f): f is ReportField => !!f);
  const head = `| ${fields.map((f) => md(f.label)).join(" | ")} |`;
  const rule = `| ${fields.map((f) => (NUMERIC.includes(f.type) ? "---:" : "---")).join(" | ")} |`;
  const body = rows.map((r) => `| ${fields.map((f) => md(cellText(f, r[f.name]))).join(" | ")} |`);
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

function tableText(b: VisualBlockOf<"table">): string {
  let rows = b.sort ? sorted(b.frame.rows, b.sort.field, b.sort.dir) : b.frame.rows;
  if (b.limit !== undefined) rows = rows.slice(0, b.limit);
  return titled(b, markdownTable(b.frame, b.columns, rows));
}

function chartText(b: VisualBlockOf<"chart">): string {
  const columns = [b.x, ...(b.series ? [b.series] : []), ...b.y];
  const label = (name: string) => b.frame.fields.find((f) => f.name === name)?.label ?? name;
  const what = `${b.variant === "burndown" ? "Burndown" : b.variant === "line" ? "Line chart" : "Bar chart"} of ${b.y
    .map(label)
    .join(", ")} by ${label(b.x)}`;
  return titled(b, `${what}\n\n${markdownTable(b.frame, columns)}`);
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

function timelineText(b: VisualBlockOf<"timeline">): string {
  const f = (name: string) => b.frame.fields.find((x) => x.name === name);
  const at = (row: ReportFrame["rows"][number], name: string | undefined) => {
    const field = name === undefined ? undefined : f(name);
    return field ? cellText(field, row[field.name]) : "—";
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

function kpiText(b: VisualBlockOf<"kpi">): string {
  const row = b.frame.rows[b.row ?? 0];
  const lines = b.figures.map((fig) => {
    const field = b.frame.fields.find((x) => x.name === fig.field);
    const dfield = fig.delta === undefined ? undefined : b.frame.fields.find((x) => x.name === fig.delta);
    const value = field && row ? cellText(field, row[field.name]) : "—";
    let delta = "";
    if (dfield && row) {
      const raw = row[dfield.name];
      delta = ` (${typeof raw === "number" && raw > 0 ? "+" : ""}${cellText(dfield, raw)})`;
    }
    return `- ${md(fig.label)}: ${md(value)}${delta}`;
  });
  return titled(b, lines.join("\n"));
}

function statusListText(b: VisualBlockOf<"status-list">): string {
  const lines = b.frame.rows.map((r) => {
    const get = (name: string | undefined) => {
      const field = name === undefined ? undefined : b.frame.fields.find((x) => x.name === name);
      return field ? cellText(field, r[field.name]) : "—";
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

/** The plain-text fallback of a block that passed `checkBlock`. */
export function blockToText(block: VisualBlock): string {
  return (BLOCK_KINDS[block.kind] as BlockKindEntry<typeof block.kind>).toText(block as never);
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
