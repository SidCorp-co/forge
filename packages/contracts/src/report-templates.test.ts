import { describe, expect, it } from "vitest";
import { type KnownQuery, validateTemplate } from "./report-templates.js";

const queries = new Map<string, KnownQuery>([
  [
    "progress-by-requirement",
    {
      params: ["limit"],
      output: [
        { name: "key", type: "ref", label: "Requirement" },
        { name: "done", type: "number", label: "Proven" },
        { name: "total", type: "number", label: "Criteria" },
        { name: "state", type: "status", label: "State" },
      ],
    },
  ],
]);

const good = {
  id: "progress",
  version: 1,
  title: "Progress",
  params: { top: { type: "number", label: "How many", default: 10 } },
  queries: [{ as: "progress", query: "progress-by-requirement", params: { limit: { param: "top" } } }],
  layout: [
    { kind: "kpi", as: "progress", figures: [{ field: "done", label: "Proven" }, { field: "total", label: "Criteria" }] },
    { kind: "status-list", as: "progress", ref: "key", status: "state" },
  ],
  narrative: [{ slot: "summary", guidance: "Say where the work stands.", maxWords: 80 }],
};

const refused = (t: unknown) => validateTemplate(t, queries).map((r) => r.message);

describe("validateTemplate", () => {
  it("accepts a template of declared queries, bindings and sensible blocks", () => {
    expect(validateTemplate(good, queries)).toEqual([]);
  });

  it("refuses an unknown key, by name", () => {
    expect(refused({ ...good, formula: "done / total" }).join()).toContain("formula: unknown key");
  });

  it("refuses an expression where a binding goes", () => {
    const t = { ...good, queries: [{ ...good.queries[0], params: { limit: { expr: "top * 2" } } }] };
    expect(refused(t).length).toBeGreaterThan(0);
  });

  it("refuses an unknown query id, naming those that exist", () => {
    const t = { ...good, queries: [{ ...good.queries[0], query: "made-up" }] };
    expect(refused(t)[0]).toContain('unknown query "made-up"; registered: progress-by-requirement');
  });

  it("refuses a param binding that is not a declared name", () => {
    const t = { ...good, queries: [{ ...good.queries[0], params: { limit: { param: "ghost" } } }] };
    expect(refused(t)[0]).toContain('binds "ghost", which the template does not declare');
  });

  it("refuses a param the query does not take", () => {
    const t = { ...good, queries: [{ ...good.queries[0], params: { depth: { literal: 2 } } }] };
    expect(refused(t)[0]).toContain('takes no param "depth"');
  });

  it("refuses a block that names no query", () => {
    const t = { ...good, layout: [{ ...good.layout[0], as: "other" }] };
    expect(refused(t)[0]).toContain('"other" names no query of this template');
  });

  it("refuses a block whose kind finds the frame not sensible", () => {
    const t = { ...good, layout: [{ kind: "timeline", as: "progress", label: "key", start: "done" }] };
    const m = refused(t).join("\n");
    expect(m).toContain("timeline block: start:");
    expect(m).toContain("the frame does not suit a timeline");
  });

  it("refuses a block kind that does not exist", () => {
    const t = { ...good, layout: [{ kind: "sparkline", as: "progress" }] };
    expect(refused(t).length).toBeGreaterThan(0);
  });

  it("refuses a narrative slot given twice and a word cap past the limit", () => {
    const slot = good.narrative[0];
    expect(refused({ ...good, narrative: [slot, slot] }).join()).toContain('slot "summary" is given twice');
    expect(refused({ ...good, narrative: [{ ...slot, maxWords: 4000 }] }).length).toBeGreaterThan(0);
  });

  it("refuses a layout of nothing", () => {
    expect(refused({ ...good, layout: [] }).length).toBeGreaterThan(0);
  });
});
