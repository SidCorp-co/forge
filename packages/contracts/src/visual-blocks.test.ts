import { describe, expect, it } from "vitest";
import type { ReportFrame } from "./report-queries.js";
import {
  BLOCK_KINDS,
  blockToText,
  checkBlock,
  checkBlocks,
  CSV_BOM,
  cellText,
  isSensible,
  kpiFigures,
  shownFrame,
  tableCsv,
  tableRows,
  VISUAL_BLOCK_KINDS,
  type VisualBlock,
  type VisualBlockKind,
} from "./visual-blocks.js";

const frame: ReportFrame = {
  fields: [
    { name: "key", type: "ref", label: "Requirement" },
    { name: "title", type: "string", label: "Title" },
    { name: "state", type: "status", label: "State" },
    { name: "done", type: "number", label: "Proven" },
    { name: "total", type: "number", label: "Criteria" },
    { name: "delta", type: "number", label: "Change" },
    { name: "eta", type: "date", label: "ETA" },
    { name: "p50", type: "date", label: "p50" },
    { name: "p85", type: "date", label: "p85" },
    { name: "took", type: "duration", label: "Took" },
    { name: "who", type: "string", label: "Waiting on" },
  ],
  rows: [
    { key: "REQ-2", title: "Beta", state: "in_progress", done: 3, total: 9, delta: 2, eta: "2026-10-20T00:00:00Z", p50: "2026-10-18", p85: "2026-10-25", took: 7_500_000, who: "Ana | QA" },
    { key: "REQ-1", title: "Alpha", state: "agreed", done: 8, total: 8, delta: -1, eta: "2026-10-12", p50: "2026-10-10", p85: "2026-10-14", took: 90_000, who: null },
  ],
};
const source = { runId: "run-1" };
const base = { v: 1 as const, source, frame };

const good: Record<VisualBlockKind, unknown> = {
  table: { ...base, kind: "table", columns: ["key", "title", "done"], sort: { field: "done", dir: "desc" }, limit: 5 },
  chart: { ...base, kind: "chart", variant: "bar", x: "key", y: ["done", "total"] },
  flow: { v: 1, kind: "flow", nodes: [{ id: "a", label: "Clarify" }, { id: "b", label: "Build" }, { id: "c", label: "Alone" }], edges: [{ from: "a", to: "b", label: "agreed" }] },
  timeline: { ...base, kind: "timeline", label: "key", start: "p50", end: "p85" },
  kpi: { ...base, kind: "kpi", figures: [{ field: "done", label: "Proven", delta: "delta" }, { field: "total", label: "All" }] },
  "status-list": { ...base, kind: "status-list", ref: "key", status: "state", waitingOn: "who" },
};

/** One planted defect per kind: the field it breaks, and the block that breaks it. */
const bad: Record<VisualBlockKind, { field: string; block: unknown }> = {
  table: { field: "columns.1", block: { ...good.table as object, columns: ["key", "nope"] } },
  chart: { field: "y.0", block: { ...good.chart as object, y: ["title"] } },
  flow: { field: "edges.0.to", block: { ...good.flow as object, edges: [{ from: "a", to: "zzz" }] } },
  timeline: { field: "start", block: { ...base, kind: "timeline", label: "key" } },
  kpi: { field: "figures.0.field", block: { ...good.kpi as object, figures: [{ field: "title", label: "T" }, { field: "total", label: "All" }] } },
  "status-list": { field: "ref", block: { ...good["status-list"] as object, ref: "title" } },
};

describe("the block table", () => {
  it("holds one entry for each of the six kinds, each answering all three questions", () => {
    expect([...VISUAL_BLOCK_KINDS].sort()).toEqual(["chart", "flow", "kpi", "status-list", "table", "timeline"]);
    for (const kind of VISUAL_BLOCK_KINDS) {
      const e = BLOCK_KINDS[kind];
      expect(e.kind).toBe(kind);
      expect(typeof e.isSensible).toBe("function");
      expect(typeof e.check).toBe("function");
      expect(typeof e.toText).toBe("function");
    }
  });
});

describe.each(VISUAL_BLOCK_KINDS)("%s", (kind) => {
  it("accepts a good block", () => {
    const r = checkBlock(good[kind]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("refuses its planted defect naming the kind, the field and the valid shape", () => {
    const r = checkBlock(bad[kind].block);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const hit = r.refusals.find((x) => x.field === bad[kind].field);
    expect(hit, JSON.stringify(r.refusals)).toBeDefined();
    expect(hit?.kind).toBe(kind);
    expect(hit?.message).toContain(`${kind} block: ${bad[kind].field}:`);
    expect(hit?.message).toContain("valid shape:");
  });

  it("refuses a figure the model typed, as an unknown key", () => {
    const r = checkBlock({ ...(good[kind] as object), values: [1, 2, 3] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.field)).toContain("values");
    expect(r.refusals[0]?.message).toContain("a number reaches it only from the frame");
  });

  it("refuses a version it does not know", () => {
    const r = checkBlock({ ...(good[kind] as object), v: 2 });
    expect(r.ok).toBe(false);
  });

  it("answers isSensible false for a frame with none of what it draws", () => {
    expect(isSensible(kind, { fields: [] })).toBe(false);
    expect(isSensible(kind, { fields: [{ name: "n", type: "date", label: "n" }] })).toBe(kind === "table");
  });

  it("answers isSensible true for a frame that suits it", () => {
    expect(isSensible(kind, frame)).toBe(true);
  });

  it("gives a non-empty text fallback", () => {
    const r = checkBlock(good[kind]);
    if (!r.ok) throw new Error("fixture invalid");
    expect(blockToText(r.block).length).toBeGreaterThan(10);
  });
});

describe("an unknown or missing kind", () => {
  it("is refused by name, with the kinds that exist, and never dropped", () => {
    const out = checkBlocks([good.table, { kind: "sparkline", v: 1 }, { v: 1 }, "text", null]);
    expect(out).toHaveLength(5);
    expect(out[0]?.ok).toBe(true);
    const unknown = out[1];
    expect(unknown?.ok).toBe(false);
    if (unknown && !unknown.ok) {
      expect(unknown.refusals[0]?.message).toContain('unknown block kind "sparkline"');
      expect(unknown.refusals[0]?.message).toContain("registered kinds: table, chart, flow, timeline, kpi, status-list");
    }
    for (const i of [2, 3, 4]) expect(out[i]?.ok).toBe(false);
  });
});

describe("table", () => {
  it("refuses a column listed twice and a sort on a missing field", () => {
    const r = checkBlock({ ...base, kind: "table", columns: ["key", "key"], sort: { field: "ghost", dir: "asc" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.field)).toEqual(expect.arrayContaining(["columns.1", "sort.field"]));
  });

  it("refuses a limit past the cap", () => {
    const r = checkBlock({ ...(good.table as object), limit: 501 });
    expect(r.ok).toBe(false);
  });

  it("writes a Markdown table, sorted and limited, escaping a pipe and marking a null", () => {
    const r = checkBlock({ ...base, kind: "table", columns: ["key", "who", "took"], sort: { field: "key", dir: "asc" }, limit: 2, title: "Waiting" });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(blockToText(r.block)).toBe(
      ["**Waiting**", "", "| Requirement | Waiting on | Took |", "| --- | --- | ---: |", "| REQ-1 | — | 1m 30s |", "| REQ-2 | Ana \\| QA | 2h 5m |"].join("\n"),
    );
  });
});

describe("chart", () => {
  it("refuses a burndown over a field that is not a date, and a series equal to x", () => {
    const r = checkBlock({ ...base, kind: "chart", variant: "burndown", x: "key", y: ["done"], series: "key" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.field)).toEqual(expect.arrayContaining(["x", "series"]));
  });

  it("refuses an unknown variant and more than six series", () => {
    expect(checkBlock({ ...(good.chart as object), variant: "pie" }).ok).toBe(false);
    expect(checkBlock({ ...(good.chart as object), y: Array(7).fill("done") }).ok).toBe(false);
  });

  it("says what it draws, then lists the points", () => {
    const r = checkBlock(good.chart);
    if (!r.ok) throw new Error(JSON.stringify(r));
    const text = blockToText(r.block);
    expect(text.startsWith("Bar chart of Proven, Criteria by Requirement")).toBe(true);
    expect(text).toContain("| REQ-2 | 3 | 9 |");
  });
});

describe("flow", () => {
  it("accepts model-authored nodes and edges with no source", () => {
    expect(checkBlock(good.flow).ok).toBe(true);
  });

  it("refuses a source without its frame, and a frame without its source", () => {
    const g = good.flow as { nodes: unknown; edges: unknown };
    for (const half of [{ source }, { frame }]) {
      const r = checkBlock({ v: 1, kind: "flow", nodes: g.nodes, edges: g.edges, ...half });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusals[0]?.message).toContain("given together or not at all");
    }
  });

  it("refuses more than sixty nodes, a duplicate id and a label holding markup", () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, label: "x" }));
    expect(checkBlock({ v: 1, kind: "flow", nodes: many, edges: [] }).ok).toBe(false);
    const r = checkBlock({ v: 1, kind: "flow", nodes: [{ id: "a", label: "<b>x</b>" }, { id: "a", label: "y" }], edges: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => x.field)).toEqual(expect.arrayContaining(["nodes.0.label", "nodes.1.id"]));
  });

  it("lists each edge and every node that has none", () => {
    const r = checkBlock(good.flow);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(blockToText(r.block)).toBe("- Clarify -> Build (agreed)\n- Alone");
  });
});

describe("timeline", () => {
  it("refuses an end without a start, half a forecast range and a non-date field", () => {
    const r = checkBlock({ ...base, kind: "timeline", label: "key", end: "title", p50: "p50" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const fields = r.refusals.map((x) => x.field);
    expect(fields).toEqual(expect.arrayContaining(["end", "p85"]));
  });

  it("accepts a p50 and p85 range alone and prints it after the item's lane", () => {
    const r = checkBlock({ ...base, kind: "timeline", label: "key", p50: "p50", p85: "p85", lane: "state" });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(blockToText(r.block)).toBe("- REQ-1 [Agreed]: p50 2026-10-10, p85 2026-10-14\n- REQ-2 [In progress]: p50 2026-10-18, p85 2026-10-25");
  });

  it("prints a start and an end, earliest first", () => {
    const r = checkBlock(good.timeline);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(blockToText(r.block).split("\n")[0]).toBe("- REQ-1: 2026-10-10 to 2026-10-14");
  });
});

describe("kpi", () => {
  it("refuses a single figure, seven figures, a repeated field and a row that is not there", () => {
    const fig = (f: string) => ({ field: f, label: f });
    expect(checkBlock({ ...base, kind: "kpi", figures: [fig("done")] }).ok).toBe(false);
    expect(checkBlock({ ...base, kind: "kpi", figures: Array(7).fill(fig("done")) }).ok).toBe(false);
    const dup = checkBlock({ ...base, kind: "kpi", figures: [fig("done"), fig("done")] });
    expect(dup.ok).toBe(false);
    const row = checkBlock({ ...(good.kpi as object), row: 9 });
    expect(row.ok).toBe(false);
    if (!row.ok) expect(row.refusals[0]?.message).toContain("row 9 does not exist; the frame has 2 row(s)");
  });

  it("prints each figure of one row with its signed change", () => {
    const r = checkBlock(good.kpi);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(blockToText(r.block)).toBe("- Proven: 3 (+2)\n- All: 9");
  });
});

describe("status-list", () => {
  it("refuses a status field that is not a status", () => {
    const r = checkBlock({ ...(good["status-list"] as object), status: "title" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals[0]?.field).toBe("status");
  });

  it("prints who each item waits on, and nothing for none", () => {
    const r = checkBlock(good["status-list"]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(blockToText(r.block)).toBe("- REQ-2: In progress (waiting on Ana \\| QA)\n- REQ-1: Agreed");
  });
});

describe("a block whose frame is not what it says", () => {
  it("is refused when a row holds a cell of the wrong type", () => {
    const broken = { ...(good.table as object), frame: { ...frame, rows: [{ ...frame.rows[0], done: "three" }] } };
    const r = checkBlock(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.some((x) => x.message.includes('cell "done" is string, but the field is number'))).toBe(true);
  });

  it("round-trips a block through JSON unchanged", () => {
    for (const kind of VISUAL_BLOCK_KINDS) {
      const r = checkBlock(good[kind]);
      if (!r.ok) throw new Error(JSON.stringify(r));
      const again = checkBlock(JSON.parse(JSON.stringify(r.block)));
      expect(again.ok && (again.block as VisualBlock)).toEqual(r.block);
    }
  });
});

describe("what a block shows, shared by the text fallback and the screen", () => {
  const checked = (kind: VisualBlockKind) => {
    const r = checkBlock(good[kind]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.block;
  };

  it("sorts a table's rows as the block says and cuts them to its limit", () => {
    const table = checked("table") as VisualBlock & { kind: "table" };
    expect(tableRows(table).map((r) => r.key)).toEqual(["REQ-1", "REQ-2"]);
    expect(tableRows({ ...table, limit: 1 }).map((r) => r.key)).toEqual(["REQ-1"]);
    const { sort: _sort, ...unsorted } = table;
    expect(tableRows(unsorted).map((r) => r.key)).toEqual(["REQ-2", "REQ-1"]);
  });

  it("reads each kpi figure from its row, with a signed delta", () => {
    const kpi = checked("kpi") as VisualBlock & { kind: "kpi" };
    expect(kpiFigures(kpi)).toEqual([
      { label: "Proven", value: "3", delta: "+2" },
      { label: "All", value: "9" },
    ]);
    expect(kpiFigures({ ...kpi, row: 1 })[0]).toEqual({ label: "Proven", value: "8", delta: "-1" });
  });
});

describe("what a block shows of its frame", () => {
  const checked = (kind: VisualBlockKind) => {
    const r = checkBlock(good[kind]);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.block;
  };
  const shown = (block: VisualBlock) => {
    const f = shownFrame(block);
    return f && { fields: f.fields.map((x) => x.name), rows: f.rows };
  };

  it("a table shows its columns over its rows, sorted and cut to its limit", () => {
    const table = checked("table") as VisualBlock & { kind: "table" };
    expect(shown({ ...table, limit: 1 })).toEqual({
      fields: ["key", "title", "done"],
      rows: [{ key: "REQ-1", title: "Alpha", done: 8 }],
    });
  });

  it("a chart shows its x and y over every row, and no column it does not draw", () => {
    const f = shown(checked("chart"));
    expect(f?.fields).toEqual(["key", "done", "total"]);
    expect(f?.rows.map((r) => r.total)).toEqual([9, 8]);
    expect(JSON.stringify(f)).not.toContain("7500000");
  });

  it("a kpi shows the one row it reads, its figures and their deltas", () => {
    const kpi = checked("kpi") as VisualBlock & { kind: "kpi" };
    expect(shown({ ...kpi, row: 1 })).toEqual({
      fields: ["done", "total", "delta"],
      rows: [{ done: 8, total: 8, delta: -1 }],
    });
  });

  it("a status list and a timeline show the fields they name", () => {
    expect(shown(checked("status-list"))?.fields).toEqual(["key", "state", "who"]);
    expect(shown(checked("timeline"))?.fields).toEqual(["key", "p50", "p85"]);
  });

  it("a flow shows no frame", () => {
    expect(shownFrame(checked("flow"))).toBeNull();
  });
});

describe("a state cell as words", () => {
  const vocab = (vocabulary: "requirement" | "releaseState" | "bcVerdict") =>
    ({ name: "state", type: "status", label: "State", vocabulary }) as const;

  it("reads a vocabulary value as the label its badge shows, never the stored token", () => {
    expect(cellText(vocab("requirement"), "in_delivery")).toBe("In delivery");
    expect(cellText(vocab("releaseState"), "awaiting_approval")).toBe("Awaiting approval");
    expect(cellText(vocab("bcVerdict"), "not_judged")).toBe("Not judged");
  });

  it("sentence-cases a value its vocabulary does not name, and a column that names none", () => {
    expect(cellText(vocab("requirement"), "on_ice")).toBe("On ice");
    expect(cellText({ name: "s", type: "status", label: "S" }, "change_request")).toBe("Change request");
  });

  it("prints the label in a table's text fallback", () => {
    const r = checkBlock({
      v: 1,
      kind: "table",
      source,
      columns: ["key", "state"],
      frame: { fields: [frame.fields[0], vocab("requirement")], rows: [{ key: "REQ-7", state: "in_delivery" }] },
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    const text = blockToText(r.block);
    expect(text).toContain("| REQ-7 | In delivery |");
    expect(text).not.toContain("in_delivery");
  });
});

describe("a table block as CSV", () => {
  const csvFrame: ReportFrame = {
    fields: [
      { name: "key", type: "ref", label: "Requirement" },
      { name: "title", type: "string", label: "Title, short" },
      { name: "state", type: "status", label: "State", vocabulary: "requirement" },
      { name: "done", type: "number", label: "Proven", unit: "criteria" },
      { name: "took", type: "duration", label: "Took" },
    ],
    rows: [
      { key: "REQ-1", title: 'Đăng nhập "nhanh"', state: "in_delivery", done: -1, took: 90_000 },
      { key: "REQ-2", title: "two\nlines", state: "agreed", done: 3, took: null },
      { key: "REQ-3", title: "=HYPERLINK(1)", state: "delivered", done: null, took: 1_000 },
    ],
  };
  const table = () => {
    const r = checkBlock({ v: 1, kind: "table", source, columns: ["key", "title", "state", "done", "took"], frame: csvFrame });
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.block as VisualBlock & { kind: "table" };
  };

  it("opens with the UTF-8 byte order mark and a heading row of the column labels", () => {
    const csv = tableCsv(table());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv.slice(1).split("\r\n")[0]).toBe('Requirement,"Title, short",State,Proven (criteria),Took');
  });

  it("quotes per RFC 4180: a quote doubled, a comma or a line break inside quotes, CRLF between records", () => {
    const csv = tableCsv(table()).slice(1);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).toContain('REQ-1,"Đăng nhập ""nhanh""",In delivery,-1,1m 30s\r\n');
    expect(csv).toContain('REQ-2,"two\nlines",Agreed,3,\r\n');
  });

  it("writes a text cell a spreadsheet would run as a formula as text, and an empty cell empty", () => {
    expect(tableCsv(table())).toContain("REQ-3,'=HYPERLINK(1),Delivered,,1s\r\n");
  });

  it("holds the rows the table shows, sorted and cut as the block says", () => {
    const csv = tableCsv({ ...table(), sort: { field: "key", dir: "desc" }, limit: 1 }).slice(1).trimEnd().split("\r\n");
    expect(csv).toHaveLength(2);
    expect(csv[1]?.startsWith("REQ-3,")).toBe(true);
  });
});
